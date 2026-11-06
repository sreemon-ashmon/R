/*
 * rruntime.js — R syntax highlighter + a tiny MOCK R console.
 *
 * NOT real R. It simulates: assignment (<- = ->), arithmetic, comparison, vectors c(), 1:10,
 * a few common functions (print, cat, paste, sum, mean, length, sqrt, round, seq, rep, ...),
 * and prints results the way R does ("[1] 1 2 3"). Anything else prints a short note.
 * Real R needs a separate server-side R process and is not included.
 *
 * window.RMock = { highlight(src), run(src, env, opts) -> [{k, t}], splitStatements(src) }
 *   line kinds (k): 'cmd' (echoed input), 'out', 'err', 'note'
 */
(function () {
  'use strict';

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ------------------------------------------------------------ highlighter */

  var KW = {};
  'if else repeat while function for next break in return'.split(' ').forEach(function (k) { KW[k] = 1; });
  var CONST = {};
  'TRUE FALSE NULL NA NA_integer_ NA_real_ NA_character_ Inf NaN T F'.split(' ').forEach(function (k) { CONST[k] = 1; });

  function highlight(src) {
    src = String(src == null ? '' : src);
    var re = /("(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$))|(#[^\n]*)|(\b0[xX][0-9a-fA-F]+L?\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?L?\b|\.\d+(?:[eE][+-]?\d+)?\b)|([A-Za-z.][A-Za-z0-9._]*)/gm;
    var out = '', last = 0, m;
    while ((m = re.exec(src))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      var tok = esc(m[0]);
      if (m[1] !== undefined) out += '<span class="tk-str">' + tok + '</span>';
      else if (m[2] !== undefined) out += '<span class="tk-com">' + tok + '</span>';
      else if (m[3] !== undefined) out += '<span class="tk-num">' + tok + '</span>';
      else if (CONST[m[4]]) out += '<span class="tk-const">' + tok + '</span>';
      else if (KW[m[4]]) out += '<span class="tk-kw">' + tok + '</span>';
      else out += tok;
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  /* ---------------------------------------------------------------- values */
  // vector: { t: 'num'|'chr'|'lgl'|'null', v: [] }

  function RErr(msg, call) { var e = new Error(msg); e.rerr = true; e.call = call; return e; }
  function Unsup(why) { var e = new Error(why || 'unsupported'); e.unsupported = true; return e; }

  function num(a) { return { t: 'num', v: a }; }
  function chr(a) { return { t: 'chr', v: a }; }
  function lgl(a) { return { t: 'lgl', v: a }; }
  var NULLV = { t: 'null', v: [] };

  function fmtNum(x) {
    if (x === null || x === undefined || isNaN(x)) return 'NA';
    if (x === Infinity) return 'Inf';
    if (x === -Infinity) return '-Inf';
    if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
    var s = String(Number(x.toPrecision(7)));
    if (/e/.test(s)) s = s.replace(/e([+-])(\d)$/, 'e$10$2');
    return s;
  }
  function elemStr(vec, i, quote) {
    var x = vec.v[i];
    if (vec.t === 'num') return fmtNum(x);
    if (vec.t === 'lgl') return x === null ? 'NA' : (x ? 'TRUE' : 'FALSE');
    if (vec.t === 'chr') return x === null ? 'NA' : (quote ? '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"' : String(x));
    return '';
  }
  function asChr(vec) { return vec.v.map(function (_, i) { return elemStr(vec, i, false); }); }
  function asNum(vec, call) {
    if (vec.t === 'num') return vec.v;
    if (vec.t === 'lgl') return vec.v.map(function (x) { return x === null ? NaN : (x ? 1 : 0); });
    if (vec.t === 'null') return [];
    throw RErr('non-numeric argument to ' + (call || 'function'), call);
  }

  function printVec(vec) {
    if (vec.t === 'null') return ['NULL'];
    if (!vec.v.length) return [vec.t === 'num' ? 'numeric(0)' : vec.t === 'chr' ? 'character(0)' : 'logical(0)'];
    var items = vec.v.map(function (_, i) { return elemStr(vec, i, true); });
    var w = 0; items.forEach(function (s) { w = Math.max(w, s.length); });
    items = items.map(function (s) { return vec.t === 'chr' ? s + new Array(w - s.length + 1).join(' ') : new Array(w - s.length + 1).join(' ') + s; });
    var labW = ('[' + items.length + ']').length;
    var per = Math.max(1, Math.floor((80 - labW) / (w + 1)));
    var lines = [];
    for (var i = 0; i < items.length; i += per) {
      var lab = '[' + (i + 1) + ']';
      lines.push(new Array(labW - lab.length + 1).join(' ') + lab + ' ' + items.slice(i, i + per).join(' '));
    }
    if (vec.t === 'chr') lines = lines.map(function (l) { return l.replace(/\s+$/, ''); });
    return lines;
  }

  /* ------------------------------------------------------------- tokenizer */

  function tokenize(s) {
    var re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?L?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z.][A-Za-z0-9._]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(%[^%\s]*%|<-|->|<=|>=|==|!=|&&|\|\||[-+*\/^()<>=!&|,:\[\]]))/g;
    var toks = [], pos = 0, m;
    s = String(s);
    while (pos < s.length && /\S/.test(s.slice(pos))) {
      re.lastIndex = pos;
      m = re.exec(s);
      if (!m || m.index !== pos) throw Unsup('tokenize');
      pos = re.lastIndex;
      if (m[1] !== undefined) toks.push({ k: 'num', v: parseFloat(m[1]) });
      else if (m[2] !== undefined) toks.push({ k: 'id', v: m[2] });
      else if (m[3] !== undefined) {
        toks.push({ k: 'str', v: m[3].slice(1, -1).replace(/\\(.)/g, function (mm, c) { return c === 'n' ? '\n' : c === 't' ? '\t' : c; }) });
      } else toks.push({ k: 'op', v: m[4] });
    }
    return toks;
  }

  /* ------------------------------------------------------------- functions */

  function recycle(a, b, fn) {
    var n = (a.length === 0 || b.length === 0) ? 0 : Math.max(a.length, b.length), out = [];
    for (var i = 0; i < n; i++) out.push(fn(a[i % a.length], b[i % b.length]));
    return out;
  }

  function combine(args) {
    var t = 'null', i;
    args.forEach(function (a) { if (a.t === 'chr') t = 'chr'; else if (a.t === 'num' && t !== 'chr') t = 'num'; else if (a.t === 'lgl' && t === 'null') t = 'lgl'; });
    if (t === 'null') return NULLV;
    var out = [];
    args.forEach(function (a) {
      if (a.t === 'null') return;
      if (t === 'chr') asChr(a).forEach(function (x) { out.push(x); });
      else if (t === 'num') asNum(a).forEach(function (x) { out.push(x); });
      else a.v.forEach(function (x) { out.push(x); });
    });
    return { t: t, v: out };
  }

  function numFn(name, fn) {
    return function (args) { if (!args.length) throw RErr('0 arguments passed to \'' + name + '\' which requires 1', name + '()'); return num(asNum(args[0], name).map(fn)); };
  }

  var FUNCS = {
    c: function (a) { return combine(a); },
    sum: function (a) { var s = 0; a.forEach(function (x) { asNum(x, 'sum').forEach(function (y) { s += y; }); }); return num([s]); },
    prod: function (a) { var s = 1; a.forEach(function (x) { asNum(x, 'prod').forEach(function (y) { s *= y; }); }); return num([s]); },
    mean: function (a) { var v = asNum(a[0], 'mean'); if (!v.length) return num([NaN]); return num([v.reduce(function (p, q) { return p + q; }, 0) / v.length]); },
    median: function (a) { var v = asNum(a[0], 'median').slice().sort(function (p, q) { return p - q; }); if (!v.length) return num([NaN]); var h = v.length >> 1; return num([v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2]); },
    max: function (a) { var all = []; a.forEach(function (x) { all = all.concat(x.t === 'chr' ? [] : asNum(x, 'max')); }); return num([all.length ? Math.max.apply(null, all) : -Infinity]); },
    min: function (a) { var all = []; a.forEach(function (x) { all = all.concat(x.t === 'chr' ? [] : asNum(x, 'min')); }); return num([all.length ? Math.min.apply(null, all) : Infinity]); },
    range: function (a) { var v = asNum(a[0], 'range'); return num([Math.min.apply(null, v), Math.max.apply(null, v)]); },
    length: function (a) { return num([a[0] ? a[0].v.length : 0]); },
    sqrt: numFn('sqrt', Math.sqrt), abs: numFn('abs', Math.abs), exp: numFn('exp', Math.exp),
    floor: numFn('floor', Math.floor), ceiling: numFn('ceiling', Math.ceil),
    log: function (a) { var b = a[1] ? asNum(a[1])[0] : Math.E; return num(asNum(a[0], 'log').map(function (x) { return Math.log(x) / Math.log(b); })); },
    log10: numFn('log10', Math.log10), log2: numFn('log2', Math.log2),
    sin: numFn('sin', Math.sin), cos: numFn('cos', Math.cos), tan: numFn('tan', Math.tan),
    round: function (a) { var d = a[1] ? asNum(a[1])[0] : 0, f = Math.pow(10, d); return num(asNum(a[0], 'round').map(function (x) { var r = Math.round(Math.abs(x) * f) / f; return x < 0 ? -r : r; })); },
    rev: function (a) { return { t: a[0].t, v: a[0].v.slice().reverse() }; },
    sort: function (a) { var v = a[0].v.slice(); v.sort(a[0].t === 'chr' ? undefined : function (p, q) { return p - q; }); return { t: a[0].t, v: v }; },
    nchar: function (a) { return num(asChr(a[0]).map(function (s) { return s.length; })); },
    toupper: function (a) { return chr(asChr(a[0]).map(function (s) { return s.toUpperCase(); })); },
    tolower: function (a) { return chr(asChr(a[0]).map(function (s) { return s.toLowerCase(); })); },
    seq_len: function (a) { var n = asNum(a[0])[0], o = []; for (var i = 1; i <= n; i++) o.push(i); return num(o); },
    seq: function (a, named) {
      var from = asNum(a[0])[0], to = a[1] ? asNum(a[1])[0] : undefined, by = named.by ? asNum(named.by)[0] : (to !== undefined && to < from ? -1 : 1), o = [];
      if (to === undefined) { to = from; from = 1; }
      if (named.length_out) { var n = asNum(named.length_out)[0]; by = n > 1 ? (to - from) / (n - 1) : 0; for (var j = 0; j < n; j++) o.push(from + j * by); return num(o); }
      if (!by) throw RErr("invalid '(to - from)/by' in seq(.)", 'seq.default()');
      for (var x = from; by > 0 ? x <= to + 1e-10 : x >= to - 1e-10; x += by) { o.push(x); if (o.length > 100000) break; }
      return num(o);
    },
    rep: function (a, named) {
      var times = named.times ? asNum(named.times)[0] : (a[1] ? asNum(a[1])[0] : 1), o = [];
      for (var i = 0; i < Math.min(times, 10000); i++) o = o.concat(a[0].v);
      return { t: a[0].t, v: o };
    },
    paste: function (a, named) { return pasteImpl(a, named.sep !== undefined ? asChr(named.sep)[0] : ' ', named.collapse); },
    paste0: function (a, named) { return pasteImpl(a, '', named.collapse); },
    class: function (a) { var t = a[0].t; return chr([t === 'num' ? 'numeric' : t === 'chr' ? 'character' : t === 'lgl' ? 'logical' : 'NULL']); },
    is_numeric: function (a) { return lgl([a[0].t === 'num']); },
    as_numeric: function (a) { return num(a[0].t === 'chr' ? a[0].v.map(function (s) { var n = Number(s); return s === '' || isNaN(n) ? NaN : n; }) : asNum(a[0])); },
    as_character: function (a) { return chr(asChr(a[0])); },
    is_na: function (a) { return lgl(a[0].v.map(function (x) { return x === null || (typeof x === 'number' && isNaN(x)); })); },
    getwd: function () { return chr(['C:/Users/user/Documents']); },
    Sys_Date: function () { var d = new Date(); return chr([d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)]); },
    Sys_time: function () { return chr([new Date().toString()]); }
  };

  function pasteImpl(args, sep, collapse) {
    var vs = args.filter(function (a) { return a.t !== 'null'; }).map(asChr), n = 0;
    vs.forEach(function (v) { n = Math.max(n, v.length); });
    var out = [];
    for (var i = 0; i < n; i++) out.push(vs.map(function (v) { return v.length ? v[i % v.length] : ''; }).join(sep));
    if (collapse !== undefined) return chr([out.join(asChr(collapse)[0])]);
    return chr(out);
  }

  var SILENT = { library: 1, require: 1, suppressWarnings: 1, suppressMessages: 1, setwd: 1, options: 1, set_seed: 1, invisible: 1, rm: 1, source: 1, install_packages: 1 };

  /* ------------------------------------------------------------- evaluator */

  function evalExpr(s, env, io) {
    var toks = tokenize(s), p = 0;
    function peek() { return toks[p]; }
    function isOp(v) { var t = peek(); return !!t && t.k === 'op' && t.v === v; }
    function eat(v) { if (!isOp(v)) throw Unsup('expected ' + v); p++; }

    function orE() { var l = andE(); while (isOp('||') || isOp('|')) { p++; var r = andE(); l = lgl(recycle(l.v, r.v, function (x, y) { return !!(x || y); })); } return l; }
    function andE() { var l = notE(); while (isOp('&&') || isOp('&')) { p++; var r = notE(); l = lgl(recycle(l.v, r.v, function (x, y) { return !!(x && y); })); } return l; }
    function notE() { if (isOp('!')) { p++; var v = notE(); return lgl(v.v.map(function (x) { return !x; })); } return cmpE(); }
    function cmpE() {
      var l = addE();
      var t = peek();
      while (t && t.k === 'op' && /^(==|!=|<=|>=|<|>)$/.test(t.v)) {
        p++; var r = addE(), op = t.v;
        var str = l.t === 'chr' || r.t === 'chr';
        var a = str ? asChr(l) : asNum(l), b = str ? asChr(r) : asNum(r);
        l = lgl(recycle(a, b, function (x, y) {
          switch (op) { case '==': return x === y; case '!=': return x !== y; case '<=': return x <= y; case '>=': return x >= y; case '<': return x < y; default: return x > y; }
        }));
        t = peek();
      }
      return l;
    }
    function arith(op, l, r) {
      if (l.t === 'chr' || r.t === 'chr') throw RErr('non-numeric argument to binary operator', null);
      var a = asNum(l), b = asNum(r);
      return num(recycle(a, b, function (x, y) {
        switch (op) {
          case '+': return x + y; case '-': return x - y; case '*': return x * y; case '/': return x / y;
          case '^': return Math.pow(x, y); case '%%': return y === 0 ? NaN : x - Math.floor(x / y) * y; case '%/%': return Math.floor(x / y);
        }
        return NaN;
      }));
    }
    function addE() { var l = mulE(); while (isOp('+') || isOp('-')) { var op = toks[p++].v; l = arith(op, l, mulE()); } return l; }
    function mulE() { var l = specE(); while (isOp('*') || isOp('/')) { var op = toks[p++].v; l = arith(op, l, specE()); } return l; }
    function specE() {
      var l = colonE();
      for (;;) {
        var t = peek();
        if (t && t.k === 'op' && (t.v === '%%' || t.v === '%/%')) { p++; l = arith(t.v, l, colonE()); }
        else if (t && t.k === 'op' && t.v === '%in%') { p++; var r = colonE(), set = asChr(r); l = lgl(asChr(l).map(function (x) { return set.indexOf(x) >= 0; })); }
        else break;
      }
      return l;
    }
    function colonE() {
      var l = unaryE();
      while (isOp(':')) {
        p++; var r = unaryE(), a = asNum(l)[0], b = asNum(r)[0], o = [];
        if (a <= b) for (var x = a; x <= b + 1e-10; x++) o.push(x); else for (var y = a; y >= b - 1e-10; y--) o.push(y);
        if (o.length > 100000) throw Unsup('too long');
        l = num(o);
      }
      return l;
    }
    function unaryE() {
      if (isOp('-')) { p++; var v = unaryE(); return num(asNum(v).map(function (x) { return -x; })); }
      if (isOp('+')) { p++; return unaryE(); }
      return powE();
    }
    function powE() { var b = postE(); if (isOp('^')) { p++; return arith('^', b, unaryE()); } return b; }

    function postE() {
      var v = primary();
      while (isOp('[')) {
        p++; var idx = orE(); eat(']');
        var ids = asNum(idx), out = [];
        ids.forEach(function (i) { if (i >= 1) out.push(v.v[i - 1] === undefined ? (v.t === 'chr' ? null : v.t === 'lgl' ? null : NaN) : v.v[i - 1]); });
        v = { t: v.t, v: out };
      }
      return v;
    }

    function primary() {
      var t = toks[p++];
      if (!t) throw Unsup('eof');
      if (t.k === 'num') return num([t.v]);
      if (t.k === 'str') return chr([t.v]);
      if (t.k === 'op' && t.v === '(') { var v = orE(); eat(')'); return v; }
      if (t.k === 'id') {
        if (isOp('(')) return call(t.v);
        switch (t.v) {
          case 'TRUE': case 'T': return lgl([true]);
          case 'FALSE': case 'F': return lgl([false]);
          case 'NULL': return NULLV;
          case 'NA': return lgl([null]);
          case 'NA_character_': return chr([null]);
          case 'NA_real_': case 'NA_integer_': return num([NaN]);
          case 'Inf': return num([Infinity]);
          case 'NaN': return num([NaN]);
          case 'pi': if (!Object.prototype.hasOwnProperty.call(env, 'pi')) return num([Math.PI]); break;
          case 'LETTERS': return chr('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
          case 'letters': return chr('abcdefghijklmnopqrstuvwxyz'.split(''));
        }
        if (Object.prototype.hasOwnProperty.call(env, t.v)) return env[t.v];
        throw RErr("object '" + t.v + "' not found", null);
      }
      throw Unsup('primary');
    }

    function call(name) {
      eat('(');
      var args = [], named = {};
      if (!isOp(')')) {
        for (;;) {
          var t = peek(), t2 = toks[p + 1];
          if (t && t.k === 'id' && t2 && t2.k === 'op' && t2.v === '=' ) { p += 2; named[t.v] = orE(); }
          else args.push(orE());
          if (isOp(',')) { p++; continue; }
          break;
        }
      }
      eat(')');
      var key = name.replace(/\./g, '_');
      if (name === 'print') { io.printed = true; return args[0] || NULLV; }
      if (name === 'cat') {
        var sep = named.sep !== undefined ? asChr(named.sep)[0] : ' ';
        var txt = args.filter(function (a) { return a.t !== 'null'; }).map(function (a) { return asChr(a).join(sep); }).join(sep);
        io.cat = (io.cat || '') + txt; io.invisible = true; return NULLV;
      }
      if (name === 'ls') { io.invisible = false; return chr(Object.keys(env).sort()); }
      if (name === 'q' || name === 'quit') { io.invisible = true; io.note = 'q() is disabled in this browser demo.'; return NULLV; }
      if (name === 'rm') { args.forEach(function () { /* names unknown after eval */ }); io.invisible = true; return NULLV; }
      if (SILENT[key]) { io.invisible = true; return NULLV; }
      if (Object.prototype.hasOwnProperty.call(FUNCS, key)) return FUNCS[key](args, named);
      throw RErr('could not find function "' + name + '"', name + '()');
    }

    var v = orE();
    if (p !== toks.length) throw Unsup('trailing');
    return v;
  }

  /* ------------------------------------------------------------ statements */

  function bracketBalance(s) {
    var d = 0, q = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '#') { while (i < s.length && s[i] !== '\n') i++; }
      else if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
    }
    return d + (q ? 1 : 0);
  }

  /** Splits source into statements: [{ text, lines:[...] }] (continuation lines grouped). */
  function splitStatements(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [], cur = null;
    lines.forEach(function (ln) {
      if (cur) {
        cur.lines.push(ln); cur.text += '\n' + ln;
        if (bracketBalance(cur.text) <= 0 && !/[-+*\/^<>=!&|,]\s*$/.test(ln.replace(/#.*$/, ''))) { out.push(cur); cur = null; }
        return;
      }
      if (!ln.trim()) { out.push({ text: '', lines: [ln], blank: true }); return; }
      var st = { text: ln, lines: [ln] };
      var core = ln.replace(/#.*$/, '');
      if (bracketBalance(ln) > 0 || /[-+*\/^<>=!&|,]\s*$/.test(core)) cur = st; else out.push(st);
    });
    if (cur) out.push(cur);
    return out;
  }

  function runStatement(text, env, autoprint) {
    var res = { lines: [], error: null };
    var t = text.replace(/\s*#[^"'\n]*$/, '').trim();
    if (!t || t.charAt(0) === '#') return res;
    var io = {};
    try {
      var m, val;
      if ((m = /^([A-Za-z.][A-Za-z0-9._]*)\s*(<-|=)\s*([\s\S]+)$/.exec(t)) && m[3].charAt(0) !== '=') {
        val = evalExpr(m[3], env, io); env[m[1]] = val; return res;
      }
      if ((m = /^([\s\S]+?)\s*->\s*([A-Za-z.][A-Za-z0-9._]*)$/.exec(t))) { val = evalExpr(m[1], env, io); env[m[2]] = val; return res; }
      if (/^(if|for|while|repeat|function)\b|^\{|^\w+\s*<-\s*function/.test(t)) throw Unsup('control flow');
      val = evalExpr(t, env, io);
      if (io.cat) io.cat.split('\n').forEach(function (l) { res.lines.push({ k: 'out', t: l }); });
      if (io.note) res.lines.push({ k: 'note', t: io.note });
      if (io.printed || (autoprint && !io.invisible)) printVec(val).forEach(function (l) { res.lines.push({ k: 'out', t: l }); });
    } catch (e) {
      if (e.rerr) res.lines.push({ k: 'err', t: 'Error' + (e.call ? ' in ' + e.call + ' :' : ':') + ' ' + e.message });
      else if (e.unsupported) res.lines.push({ k: 'note', t: '(demo console: this statement is not simulated)' });
      else res.lines.push({ k: 'err', t: 'Error: ' + (e.message || 'unexpected input') });
      res.error = true;
    }
    return res;
  }

  /**
   * Runs source. opts.echo: echo each statement as "> code" / "+ more" (like the RStudio console).
   * Stops after the first error, as R does.
   */
  function run(src, env, opts) {
    opts = opts || {};
    var lines = [];
    var stmts = splitStatements(src);
    for (var i = 0; i < stmts.length; i++) {
      var st = stmts[i];
      if (st.blank) { continue; }
      if (opts.echo) st.lines.forEach(function (l, j) { lines.push({ k: 'cmd', t: (j === 0 ? '> ' : '+ ') + l }); });
      var r = runStatement(st.text, env, opts.autoprint !== false);
      r.lines.forEach(function (l) { lines.push(l); });
      if (r.error) break;
    }
    return lines;
  }

  window.RMock = { highlight: highlight, run: run, splitStatements: splitStatements };
})();
