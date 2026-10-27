//! Splits a SQL script into individual statements the way the mysql CLI does:
//! honours quotes, comments and `DELIMITER` directives.

pub fn split_sql(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut delimiter: Vec<char> = vec![';'];
    let mut cur = String::new();
    // Whether `cur` holds anything other than whitespace and comments.
    let mut has_code = false;
    let mut i = 0;

    let flush = |cur: &mut String, has_code: &mut bool, out: &mut Vec<String>| {
        let s = cur.trim();
        if *has_code && !s.is_empty() {
            out.push(s.to_string());
        }
        cur.clear();
        *has_code = false;
    };

    while i < n {
        let c = chars[i];

        // DELIMITER directive is only recognised at the start of a statement.
        if !has_code && (c == 'd' || c == 'D') && starts_with_ci(&chars, i, "delimiter") {
            let after = i + 9;
            if after < n && (chars[after] == ' ' || chars[after] == '\t') {
                let mut j = after;
                while j < n && chars[j] != '\n' {
                    j += 1;
                }
                let d: String = chars[after..j].iter().collect();
                let d = d.trim();
                if !d.is_empty() {
                    delimiter = d.chars().collect();
                }
                cur.clear();
                i = j;
                continue;
            }
        }

        match c {
            '\'' | '"' | '`' => {
                has_code = true;
                cur.push(c);
                i += 1;
                while i < n {
                    let ch = chars[i];
                    cur.push(ch);
                    i += 1;
                    if ch == '\\' && c != '`' && i < n {
                        cur.push(chars[i]);
                        i += 1;
                    } else if ch == c {
                        break;
                    }
                }
                continue;
            }
            '#' => {
                while i < n && chars[i] != '\n' {
                    cur.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            '-' if i + 1 < n
                && chars[i + 1] == '-'
                && (i + 2 >= n || chars[i + 2].is_whitespace()) =>
            {
                while i < n && chars[i] != '\n' {
                    cur.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            '/' if i + 1 < n && chars[i + 1] == '*' => {
                // `/*! ... */` executable comments carry real code.
                if i + 2 < n && (chars[i + 2] == '!' || chars[i + 2] == '+') {
                    has_code = true;
                }
                cur.push_str("/*");
                i += 2;
                while i < n {
                    if chars[i] == '*' && i + 1 < n && chars[i + 1] == '/' {
                        cur.push_str("*/");
                        i += 2;
                        break;
                    }
                    cur.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            _ => {}
        }

        if matches_at(&chars, i, &delimiter) {
            flush(&mut cur, &mut has_code, &mut out);
            i += delimiter.len();
            continue;
        }

        if !c.is_whitespace() {
            has_code = true;
        }
        cur.push(c);
        i += 1;
    }
    flush(&mut cur, &mut has_code, &mut out);
    out
}

fn starts_with_ci(chars: &[char], at: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if at + w.len() > chars.len() {
        return false;
    }
    chars[at..at + w.len()]
        .iter()
        .zip(w.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn matches_at(chars: &[char], at: usize, pat: &[char]) -> bool {
    at + pat.len() <= chars.len() && chars[at..at + pat.len()] == *pat
}

#[cfg(test)]
mod tests {
    use super::split_sql;

    #[test]
    fn basic() {
        let v = split_sql("select 1; select ';' ; -- c;\n select 2");
        assert_eq!(v, vec!["select 1", "select ';'", "-- c;\n select 2"]);
    }

    #[test]
    fn comments_only_are_dropped() {
        assert!(split_sql("-- hello\n/* x */ ;  ").is_empty());
        assert_eq!(
            split_sql("/*!40101 SET NAMES utf8 */;"),
            vec!["/*!40101 SET NAMES utf8 */"]
        );
    }

    #[test]
    fn delimiter() {
        let sql =
            "DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END;;\nDELIMITER ;\nCALL p();";
        let v = split_sql(sql);
        assert_eq!(
            v,
            vec!["CREATE PROCEDURE p() BEGIN SELECT 1; END", "CALL p()"]
        );
    }

    #[test]
    fn escapes() {
        let v = split_sql(r"insert into t values ('a\';b', 'c''d;'); select `x;y`");
        assert_eq!(v.len(), 2);
    }
}
