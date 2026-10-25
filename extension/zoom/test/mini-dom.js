// Just enough of a DOM to run zoom/transcript.js against a saved page in Node with no
// packages: element tree, textContent, getAttribute, and querySelector(All) for
// "tag.class#id" compounds joined by descendant spaces, with comma lists.
// Exposed as a factory so the test can load it with the same vm trick as the sources.

function createMiniDom() {
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var RAW = { script: 1, style: 1, textarea: 1 };
  var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
      if (e[0] === '#') {
        var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
      }
      return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : all;
    });
  }

  function Node(tag, attrs, parent) {
    this.tagName = tag;
    this.attrs = attrs;
    this.parent = parent;
    this.children = [];
  }
  Node.prototype.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  };
  Object.defineProperty(Node.prototype, 'textContent', {
    get: function () {
      var out = '';
      for (var i = 0; i < this.children.length; i++) {
        var c = this.children[i];
        out += typeof c === 'string' ? c : c.textContent;
      }
      return out;
    },
    set: function (text) {
      this.children = [String(text)];
    }
  });

  // Just enough writing for embed mode: attributes, new elements, append and remove.
  Node.prototype.setAttribute = function (name, value) {
    this.attrs[name] = String(value);
  };
  Node.prototype.appendChild = function (child) {
    if (child.parent) child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  };
  Node.prototype.remove = function () {
    if (!this.parent) return;
    var self = this;
    this.parent.children = this.parent.children.filter(function (c) { return c !== self; });
    this.parent = null;
  };
  Node.prototype.createElement = function (tag) {
    return new Node(String(tag).toLowerCase(), {}, null);
  };
  Node.prototype.getElementById = function (id) {
    var found = null;
    walk(this, function (el) { if (!found && el.getAttribute('id') === id) found = el; });
    return found;
  };
  Object.defineProperty(Node.prototype, 'documentElement', {
    get: function () { return this.querySelector('html'); }
  });
  Object.defineProperty(Node.prototype, 'head', {
    get: function () { return this.querySelector('head'); }
  });
  Node.prototype.querySelectorAll = function (selector) {
    var groups = selector.split(',').map(function (g) { return g.trim().split(/\s+/).map(parseCompound); });
    var out = [];
    walk(this, function (el) {
      for (var i = 0; i < groups.length; i++) {
        if (matchesChain(el, groups[i])) { out.push(el); return; }
      }
    });
    return out;
  };
  Node.prototype.querySelector = function (selector) {
    return this.querySelectorAll(selector)[0] || null;
  };

  function walk(root, fn) {
    for (var i = 0; i < root.children.length; i++) {
      var c = root.children[i];
      if (typeof c !== 'string') { fn(c); walk(c, fn); }
    }
  }

  function parseCompound(s) {
    var m = s.match(/^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i);
    if (!m) throw new Error('mini-dom: unsupported selector ' + s);
    var classes = [];
    var id = null;
    (m[2].match(/[.#][\w-]+/g) || []).forEach(function (p) {
      if (p[0] === '.') classes.push(p.slice(1)); else id = p.slice(1);
    });
    return { tag: m[1].toLowerCase(), classes: classes, id: id };
  }

  function matchesCompound(el, c) {
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.getAttribute('id') !== c.id) return false;
    var cls = (el.getAttribute('class') || '').split(/\s+/);
    for (var i = 0; i < c.classes.length; i++) if (cls.indexOf(c.classes[i]) < 0) return false;
    return true;
  }

  function matchesChain(el, chain) {
    if (!matchesCompound(el, chain[chain.length - 1])) return false;
    var i = chain.length - 2;
    var p = el.parent;
    while (i >= 0 && p) {
      if (p.tagName && matchesCompound(p, chain[i])) i--;
      p = p.parent;
    }
    return i < 0;
  }

  function parseAttrs(s) {
    var attrs = {};
    var re = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    var m;
    while ((m = re.exec(s))) {
      var v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
      attrs[m[1].toLowerCase()] = decode(v);
    }
    return attrs;
  }

  function parse(html) {
    var root = new Node(null, {}, null);
    var cur = root;
    var i = 0;
    var tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/y;
    while (i < html.length) {
      var lt = html.indexOf('<', i);
      if (lt < 0) lt = html.length;
      if (lt > i) cur.children.push(decode(html.slice(i, lt)));
      if (lt >= html.length) break;
      if (html.startsWith('<!--', lt)) {
        var endC = html.indexOf('-->', lt + 4);
        i = endC < 0 ? html.length : endC + 3;
        continue;
      }
      if (html[lt + 1] === '!' || html[lt + 1] === '?') {
        var endD = html.indexOf('>', lt);
        i = endD < 0 ? html.length : endD + 1;
        continue;
      }
      tagRe.lastIndex = lt;
      var m = tagRe.exec(html);
      if (!m) { cur.children.push('<'); i = lt + 1; continue; }
      i = tagRe.lastIndex;
      var tag = m[2].toLowerCase();
      if (m[1]) {
        for (var p = cur; p && p !== root; p = p.parent) {
          if (p.tagName === tag) { cur = p.parent; break; }
        }
        continue;
      }
      var el = new Node(tag, parseAttrs(m[3]), cur);
      cur.children.push(el);
      if (RAW[tag]) {
        var close = html.toLowerCase().indexOf('</' + tag, i);
        if (close < 0) close = html.length;
        el.children.push(html.slice(i, close));
        var gt = html.indexOf('>', close);
        i = gt < 0 ? html.length : gt + 1;
      } else if (!VOID[tag] && !m[4]) {
        cur = el;
      }
    }
    return root;
  }

  return { parse: parse };
}
