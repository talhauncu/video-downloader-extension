// Minimal XML parser: enough for DASH manifests (elements, attributes, text,
// self-closing tags, comments, CDATA, XML declaration). Namespaced names are
// kept as written ("xlink:href"). Works in service workers and Node, where
// DOMParser is not available.

/** @typedef {{name:string, attrs:Record<string,string>, children:XmlNode[], text:string}} XmlNode */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/**
 * @param {string} xml
 * @returns {XmlNode} root element
 */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += xml.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Find the end of the tag, honouring quotes.
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const tag = xml.slice(lt + 1, j);
    i = j + 1;

    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      // Pop to the matching element (tolerate mismatches).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    const node = { name, attrs: space === -1 ? {} : parseAttrs(body.slice(space)), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root.children.find((c) => c.name) ?? root;
}

/** Direct children with a given name. */
export function childrenOf(node, name) {
  return node.children.filter((c) => c.name === name);
}

export function childOf(node, name) {
  return node.children.find((c) => c.name === name) ?? null;
}

export function textOf(node) {
  return node ? node.text.trim() : '';
}
