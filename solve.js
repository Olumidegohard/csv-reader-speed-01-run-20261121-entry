// Fast single-pass CSV reader: a byte-exact drop-in for csv-reader 1.0.0
// (kit baselines/csv-reader/vendor/csv-reader/index.js). It answers run(input)
// with {columns, rows, errors} exactly as csv-reader does, for every input.
//
// Speed comes from chunk scanning instead of a per-character loop: the next
// delimiter of an unquoted field is found with indexOf (native speed) and the
// field is one slice, so a plain field costs a few native scans and one sliced
// string. A quoted field is the same shape: indexOf for its closing quote and
// one slice for its body. Only the rare broken shapes take a slow path: a
// doubled quote or a line break inside quotes (slowQuoted), a stray CR in an
// unquoted field, or a quote that never closes (re-read as unquoted).
//
// The common unquoted field costs one indexOf for the next comma and a
// check of that short slice for a line break or a stray CR, so no scan ever
// runs past the field it is looking at; the quoted body is sliced once and
// checked for line breaks on that short slice too.
//
// Semantics, copied from the reference, not from any other CSV library:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based
//     line its record starts on, row its record's index in rows (null for the
//     header); a field's quote_junk when the field ends, a record's
//     short_row or long_row when the record ends.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read, and how it ended (COMMA, BREAK or END).
  let fieldValue = '';
  let fieldEnded = END;

  // The body of a quoted field that holds a doubled quote or a line break:
  // [start, end) of the text, each "" one quote, each CRLF or lone CR one LF.
  // Line breaks inside it count toward `line`, as the reference counts them.
  function slowQuoted(start, end) {
    let v = '';
    let seg = start;
    let i = start;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        // Inside a quoted field a quote only ever comes doubled.
        if (text.charCodeAt(i + 1) === 34) {
          v += text.slice(seg, i) + '"';
          i += 2;
          seg = i;
          continue;
        }
        i += 1;
        continue;
      }
      if (c === 13) {
        v += text.slice(seg, i) + '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    if (seg < end) v += text.slice(seg, end);
    return v;
  }

  // Reads unquoted characters onto `init` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Sets fieldValue/fieldEnded.
  // Only the rare paths use this: the junk after a closing quote and the
  // re-read of an unterminated quote. The common unquoted field is scanned
  // inline in the record loop below.
  function readUnquoted(init) {
    let value = init;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let m = comma;
      let kind = COMMA;
      if (lf !== -1 && (m === -1 || lf < m)) {
        m = lf;
        kind = BREAK;
      }
      if (cr !== -1 && (m === -1 || cr < m)) {
        m = cr;
        kind = 2; // a CR: a line break when followed by LF, else a stray CR
      }
      if (m === -1) {
        fieldValue = value === '' ? text.slice(pos) : value + text.slice(pos);
        pos = n;
        fieldEnded = END;
        return;
      }
      if (kind === COMMA) {
        fieldValue = value === '' ? text.slice(pos, m) : value + text.slice(pos, m);
        pos = m + 1;
        fieldEnded = COMMA;
        return;
      }
      if (kind === BREAK) {
        fieldValue = value === '' ? text.slice(pos, m) : value + text.slice(pos, m);
        pos = m + 1;
        line += 1;
        fieldEnded = BREAK;
        return;
      }
      // A CR.
      if (text.charCodeAt(m + 1) === 10) {
        fieldValue = value === '' ? text.slice(pos, m) : value + text.slice(pos, m);
        pos = m + 2;
        line += 1;
        fieldEnded = BREAK;
        return;
      }
      // A lone CR: dropped, and the field goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value = value === '' ? text.slice(pos, m) : value + text.slice(pos, m);
      pos = m + 1;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let q = text.indexOf('"', pos + 1);
        let escaped = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          escaped = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as an unquoted field.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          readUnquoted('"');
        } else {
          // The body, sliced once; line breaks are checked on that short
          // slice, never by a scan past the closing quote.
          const body = text.slice(pos + 1, q);
          const value = !escaped && body.indexOf('\r') === -1 && body.indexOf('\n') === -1
            ? body
            : slowQuoted(pos + 1, q);
          pos = q + 1;
          if (pos >= n) {
            fieldValue = value;
            fieldEnded = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fieldValue = value;
              fieldEnded = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fieldValue = value;
              fieldEnded = BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fieldValue = value;
              fieldEnded = BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              readUnquoted(value);
              if (fieldValue.length > value.length) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
        }
      } else {
        quoted = false;
        // The common field: unquoted. One indexOf finds the next comma; the
        // field is the slice up to it, and a line break or a stray CR inside
        // that short slice is checked on the slice itself, so no scan ever
        // runs past the field. A stray CR anywhere but as the last character
        // of a CRLF falls back to readUnquoted, which drops it (stray_cr).
        const comma = text.indexOf(',', pos);
        if (comma === -1) {
          const lf = text.indexOf('\n', pos);
          if (lf === -1) {
            const f = text.slice(pos);
            if (f.indexOf('\r') === -1) {
              fieldValue = f;
              pos = n;
              fieldEnded = END;
            } else {
              readUnquoted('');
            }
          } else {
            const f = text.slice(pos, lf);
            const ri = f.indexOf('\r');
            if (ri === -1) {
              fieldValue = f;
              pos = lf + 1;
              line += 1;
              fieldEnded = BREAK;
            } else if (ri === f.length - 1) {
              fieldValue = f.slice(0, -1);
              pos = lf + 1;
              line += 1;
              fieldEnded = BREAK;
            } else {
              readUnquoted('');
            }
          }
        } else {
          const f = text.slice(pos, comma);
          const ni = f.indexOf('\n');
          if (ni === -1) {
            if (f.indexOf('\r') === -1) {
              fieldValue = f;
              pos = comma + 1;
              fieldEnded = COMMA;
            } else {
              readUnquoted('');
            }
          } else {
            const g = f.slice(0, ni);
            const ri = g.indexOf('\r');
            if (ri === -1) {
              fieldValue = g;
              pos = pos + ni + 1;
              line += 1;
              fieldEnded = BREAK;
            } else if (ri === g.length - 1) {
              fieldValue = g.slice(0, -1);
              pos = pos + ni + 1;
              line += 1;
              fieldEnded = BREAK;
            } else {
              readUnquoted('');
            }
          }
        }
      }
      fields.push(fieldValue);
    } while (fieldEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
