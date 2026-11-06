/*
 * rstudio-icons.js — small inline-SVG icon set that imitates the RStudio (Windows) toolbar icons.
 * window.RI.el(name, size) returns a <span class="ri"> holding the SVG.
 */
(function () {
  'use strict';

  var BLUE = '#3f7fc3', LBLUE = '#a9c7ea', GREEN = '#1fa84f', YEL = '#e7c453', DYEL = '#c99a2e', GRAY = '#8a949c', RED = '#d8453b';

  function svg(inner, w, h, vb) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (w || 20) + '" height="' + (h || 20) + '" viewBox="' + (vb || '0 0 20 20') +
      '" aria-hidden="true" focusable="false">' + inner + '</svg>';
  }

  var I = {};

  /* ---- title bar / logos ---- */
  I.rlogo = svg('<circle cx="10" cy="10" r="9.2" fill="#3b84d9"/><path d="M6.8 14.6V5.6h3.6c1.9 0 3 .9 3 2.4 0 1.2-.7 2-1.8 2.3l2.1 4.3h-1.5l-1.9-4H8v4zm1.2-5h2.3c1.1 0 1.8-.5 1.8-1.5s-.7-1.4-1.8-1.4H8z" fill="#fff"/>');
  I.rlogoSmall = svg('<ellipse cx="10" cy="10" rx="9" ry="8.4" fill="#d7e5f5" stroke="#8fb3de" stroke-width="1"/><path d="M6.2 15V5h4.6c2.2 0 3.5 1 3.5 2.7 0 1.4-.9 2.3-2.2 2.6L14.4 15h-2.2l-2-4.2H8.3V15zM8.3 9.2h2.3c.9 0 1.5-.4 1.5-1.2s-.6-1.2-1.5-1.2H8.3z" fill="#1c5fb8"/>', 18, 18);
  I.rlogoCon = svg('<ellipse cx="11" cy="11" rx="10" ry="9.4" fill="#cfd8e3" stroke="#9aa9bd"/><ellipse cx="11" cy="11" rx="7.6" ry="7" fill="#e9eef5"/><path d="M7.4 16.4V5.8h5.2c2.4 0 3.8 1.1 3.8 3 0 1.5-1 2.6-2.5 2.9l2.5 4.7h-2.5l-2.2-4.4H9.7v4.4zM9.7 9.5h2.7c1 0 1.6-.5 1.6-1.3s-.6-1.3-1.6-1.3H9.7z" fill="#1f5fae"/>', 22, 22, '0 0 22 22');

  /* ---- document icon (tabs) ---- */
  I.doc = svg('<path d="M4.5 1.5h8l3 3v13h-11z" fill="#fff" stroke="#b9bfc7"/><path d="M12.5 1.5v3h3" fill="#eef1f5" stroke="#b9bfc7"/><path d="M7 14.5V6h3.4c1.6 0 2.5.8 2.5 2 0 1-.6 1.7-1.5 1.9l1.7 4.6h-1.3L9.9 10.1H8.2v4.4zM8.2 9.1h2c.8 0 1.3-.3 1.3-1s-.5-1.1-1.3-1.1h-2z" fill="#1d5fb4" transform="translate(-.4 .4)"/>', 18, 20, '4 1 12 17.5');
  I.docText = svg('<path d="M4.5 1.5h8l3 3v13h-11z" fill="#fff" stroke="#b9bfc7"/><path d="M12.5 1.5v3h3" fill="#eef1f5" stroke="#b9bfc7"/><path d="M7 8h6M7 10.5h6M7 13h4" stroke="#6b7580" stroke-width="1.2"/>', 18, 20, '4 1 12 17.5');

  /* ---- window buttons ---- */
  I.winMin = svg('<path d="M0 .5h10" stroke="#000" stroke-width="1"/>', 10, 2, '0 0 10 2');
  I.winRestore = svg('<path d="M2.5 2.5V.5h8v8h-2" fill="none" stroke="#000"/><rect x=".5" y="2.5" width="8" height="8" fill="none" stroke="#000"/>', 11, 11, '0 0 11 11');
  I.winClose = svg('<path d="M.5.5l10 10M10.5.5l-10 10" stroke="#000" stroke-width="1.1"/>', 11, 11, '0 0 11 11');

  /* ---- main toolbar ---- */
  I.newfile = svg('<circle cx="10" cy="10" r="6.6" fill="#fff" stroke="' + GREEN + '" stroke-width="3.2"/><rect x="6.4" y="8.9" width="7.2" height="2.2" fill="' + GREEN + '"/><rect x="13.2" y="8.9" width="3" height="2.2" fill="' + GREEN + '"/>', 22, 22, '0 0 20 20');
  I.newproj = svg('<rect x="9" y="5" width="9.5" height="12" rx="2" fill="#a9c3ef" stroke="#7ea1d6"/><circle cx="8" cy="8" r="5" fill="#fff" stroke="' + GREEN + '" stroke-width="2.6"/><path d="M12 8l3 4" stroke="#4aa3d8" stroke-width="1.5"/>', 24, 22, '1.5 2 17.5 16');
  I.openfile = svg('<path d="M2.5 7.5c0-1 .6-1.6 1.6-1.6h3.6l1.5 1.8h4.2c1 0 1.6.6 1.6 1.6v6.2c0 1-.6 1.6-1.6 1.6H4.1c-1 0-1.6-.6-1.6-1.6z" fill="' + YEL + '" stroke="' + DYEL + '"/><path d="M11 6.5h4V4l4 3.6-4 3.6V9h-4z" fill="' + GREEN + '" transform="translate(-1 -1.3) scale(.95)"/>', 24, 18, '1.5 2.5 19 15');
  I.save = svg('<rect x="2.5" y="2.5" width="15" height="15" rx="1.6" fill="#4f86c6" stroke="#2f62a2"/><rect x="5.2" y="2.9" width="9.6" height="5.4" fill="#e9f0fa"/><rect x="5.6" y="11.2" width="8.8" height="5.8" rx=".8" fill="#2f62a2"/><rect x="9.4" y="12.3" width="2.2" height="3.6" fill="#dbe7f6"/>', 22, 22);
  I.saveall = svg('<path d="M3.5 7.5l5-3.8 8 1.8v10.2l-5 2-8-1.7z" fill="#8fb4e0" stroke="#5f8ec6"/><path d="M8.5 3.7v10l7.9 1.9" stroke="#5f8ec6" fill="none"/><path d="M5.6 11.4l2.2.5v3.6l-2.2-.5z" fill="#fff"/>', 22, 22);
  I.printer = svg('<circle cx="10" cy="10" r="7.6" fill="#e8d8b8" stroke="#bcae92"/><path d="M10 10L3.3 7.2A7.6 7.6 0 0 0 4 14z" fill="#a9c7ea"/><path d="M10 10l7.6 1A7.6 7.6 0 0 1 10 17.6z" fill="#cfe0f3"/>', 22, 22);
  I.wrench = svg('<path d="M3.6 16.4l7-7a3.4 3.4 0 0 1 4.6-3.6l-2 2 .5 1.6 1.6.5 2-2a3.4 3.4 0 0 1-3.6 4.6l-7 7z" fill="#8f9eb0" stroke="#6f7f93"/>', 24, 22);
  I.panes = svg('<rect x="2.5" y="2.5" width="15" height="15" rx="2.5" fill="#dcdfe3" stroke="#bfc4ca"/><path d="M6 8h8M6 10.5h8M6 13h5" stroke="#c4c9cf" stroke-width="1.2"/>', 22, 22);

  /* ---- source toolbar ---- */
  I.back = svg('<path d="M3 10l6.5-6.5v3.6h7v5.8h-7v3.6z" fill="#dbe7f5" stroke="#bccde4"/>', 22, 22);
  I.fwd = svg('<path d="M17 10l-6.5-6.5v3.6h-7v5.8h7v3.6z" fill="#dbe7f5" stroke="#bccde4"/>', 22, 22);
  I.showwin = svg('<path d="M3 15c3-1 4-5 6-8l2 2c-1 2-1 5-3 7z" fill="#bfe0d2" stroke="#8cc4ad"/><path d="M9 6c2-3 5-3 7-1l-2 5z" fill="#cfe6f4" stroke="#a5cde3"/>', 22, 22);
  I.find = svg('<circle cx="8" cy="8" r="5.4" fill="#d8ecfb" stroke="#4a93c8" stroke-width="1.8"/><path d="M12 12l5.2 5.2" stroke="#9c6b1f" stroke-width="2.6" stroke-linecap="round"/><path d="M5.6 7.6c.6-1.6 2.2-2.4 3.8-1.8" stroke="#fff" fill="none" stroke-width="1.2"/>', 22, 22);
  I.wand = svg('<path d="M3.2 16.8l1.4-4.6L14.6 2.4c1-.6 2.4-.2 3 .8s.4 2.4-.6 3L7 15.4z" fill="#d2693a" stroke="#7a3216"/><path d="M5 12.6l2.4 2.4-3.6 1.4z" fill="#f1cd72" stroke="#7a3216" stroke-width=".8"/><path d="M14.4 3l2.8 2.8" stroke="#b9c4d2" stroke-width="2"/>', 22, 22);
  I.compile = svg('<path d="M6 3h7l2.5 2.5V17H6z" fill="#e6edf5" stroke="#c9d4e1"/><path d="M13 3v3h2.5" fill="none" stroke="#c9d4e1"/>', 22, 22);
  I.run = svg('<rect x="1.5" y="4.5" width="10" height="9" rx="1.5" fill="#fff" stroke="#c6cfdc"/><path d="M3.4 8h1.5M6 8h1.5M3.4 10.2h1.5" stroke="#8fb0e6" stroke-width="1.2"/><path d="M8.5 6h4V3.5l5.5 5.2-5.5 5.2V11.4h-4z" fill="' + GREEN + '" stroke="#12803a" stroke-width=".8"/>', 18, 16, '0 0 20 17');
  I.rerun = svg('<rect x="2.5" y="1.5" width="10" height="13" rx="1.5" fill="#fff" stroke="#9fb6d8"/><path d="M4 5h4v2H4zM4 9h3" stroke="#2c58c7" stroke-width="2"/><path d="M10.5 9h4V6.6l5 4.6-5 4.6V13.4h-4z" fill="' + GREEN + '" stroke="#12803a" stroke-width=".8" transform="translate(-1.5 -3.2)"/>', 25, 20, '0 0 20 17');
  I.upfaded = svg('<path d="M3.5 12.5c0-5 3-8 7-8 3 0 5 2 5 5s-2 5-5 5c-1.4 0-2.4-.6-2.8-1.6" fill="#eef4fb" stroke="#b9cde6"/><path d="M5 11l-2 3 3 .5" fill="#cfe0f3" stroke="#b9cde6"/>', 22, 22);
  I.downfaded = svg('<path d="M7 5c2-2 5-1.6 6.5.6 1.4 2-.2 4-2.6 6.2l-3 5-3-1.5 2-4.5C6.5 9 5.8 6.4 7 5z" fill="#eef1f4" stroke="#c3cad2"/>', 22, 22);
  I.sourceIcon = svg('<rect x="2.5" y="2" width="11" height="15" rx="1.5" fill="#fff" stroke="#c5cbd6"/><path d="M4 4.6h4" stroke="#6f86c6" stroke-width="1.2"/><path d="M4 15.2h6" stroke="#d97b7b" stroke-width="1.2"/><circle cx="14" cy="10.6" r="4.4" fill="#4a9ad9" stroke="#2f78b8"/><path d="M11.8 10.2c1-1.6 3-1.8 4.2-.6" stroke="#fff" fill="none"/>', 24, 22);
  I.upDoc = svg('<path d="M10 3.5l5.5 5.5h-3v3.5h-5V9h-3z" fill="#e4e5e7" stroke="#c9ccd1"/><path d="M5 13.5h10v3.5H5z" fill="#eceef0" stroke="#d2d5d9"/>', 22, 22);

  /* ---- panes ---- */
  I.paneMin = svg('<rect x=".5" y="4.5" width="14" height="4" fill="#f4f5f7" stroke="#6b7480"/><path d="M.5 5.5h14" stroke="#6b7480" stroke-width="2"/>', 15, 10, '0 0 15 10');
  I.paneMax = svg('<rect x=".5" y=".5" width="14" height="13" fill="#f4f5f7" stroke="#6b7480"/><path d="M.5 1.5h14" stroke="#6b7480" stroke-width="3"/>', 15, 14, '0 0 15 14');
  I.close = svg('<path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="#8d9299" stroke-width="1.6"/>', 10, 10, '0 0 10 10');

  /* ---- environment ---- */
  I.loadws = svg('<path d="M2 7c0-1 .6-1.6 1.6-1.6h3.4l1.4 1.7h4.5c1 0 1.5.6 1.5 1.6v5.6c0 1-.6 1.6-1.6 1.6H3.6C2.6 16.5 2 16 2 15z" fill="#efc65a" stroke="#c9972a"/><path d="M12 4h4.4l-1.2-1.2" stroke="#22a55a" fill="none" stroke-width="1.6"/><path d="M11 3.4h5.5v5l-1.8-1.6" fill="none" stroke="#22a55a" stroke-width="1.4" transform="translate(0 -.4)"/>', 27, 21, '1.5 2 17 15');
  I.savews = svg('<rect x="2.5" y="2.5" width="15" height="15" rx="1.6" fill="#5b92d0" stroke="#3a6cab"/><rect x="5.2" y="2.9" width="9.6" height="5.2" fill="#eaf1fb"/><rect x="5.6" y="11.2" width="8.8" height="5.8" rx=".8" fill="#3a6cab"/><rect x="9.4" y="12.3" width="2.2" height="3.6" fill="#dbe7f6"/>', 22, 22);
  I.import = svg('<rect x="1.5" y="4" width="14" height="11" rx="1.4" fill="#f3f6f9" stroke="#c8d1dc"/><path d="M3 8l3 2 2-3 3 3" stroke="#6aa98a" fill="none" stroke-width="1.2"/><path d="M8 7c2-2 5-2 8-.5l-2 1.5 4 .5-3 3" stroke="#1fa84f" fill="none" stroke-width="1.8"/>', 24, 20, '0.5 3 21 13');
  I.cube = svg('<path d="M10 2l6.6 3v8.6L10 17 3.4 13.6V5z" fill="#f7c63c" stroke="#d29a12"/><path d="M3.4 5L10 8.2 16.6 5M10 8.2V17" stroke="#d29a12" fill="none"/><path d="M10 8.2V17l-6.6-3.4V5z" fill="#ffd96a" opacity=".6"/>', 22, 22);
  I.broom = svg('<path d="M14.5 2.5l2.2 2-4.3 5.3-3-2.4z" fill="#b8722b" stroke="#7b4513"/><path d="M8.7 8.1l3 2.4c-.4 2.6-2 5-5.2 7.2-1.4.6-3-.4-3.6-.9 2.2-1.6 2.8-3.5 2.6-5.4z" fill="#f0c349" stroke="#c19224"/><path d="M5 12l1.6 1.4M6.6 10.4l1.6 1.4" stroke="#c19224" stroke-width=".8"/>', 22, 22);
  I.list = svg('<rect x="1.5" y="3.5" width="14" height="11" rx="1.2" fill="#f4f5f7" stroke="#c6ccd4"/><path d="M3.5 7h4M3.5 9.5h6M3.5 12h5" stroke="#a9b1bb" stroke-width="1.2"/>', 22, 20, '0 0 17 17');
  I.grid = svg('<rect x="2.5" y="2.5" width="12" height="15" rx="1.2" fill="#eceef1" stroke="#d0d4da"/><path d="M5 6h7M5 8.6h7M5 11.2h7M5 13.8h7" stroke="#d0d4da"/>', 22, 22);
  I.globe = svg('<circle cx="9.5" cy="9.5" r="7.2" fill="#b36fc9" stroke="#7a4a95"/><path d="M4 7c1.6-1.8 4.6-1.4 5.4.6s2.4 2.4 4.2 1.4" fill="#e2b441" stroke="none"/><path d="M5 12c2 .4 3.6 1.8 4.2 4" stroke="#69b4e3" stroke-width="3" fill="none"/><circle cx="13.5" cy="13.5" r="3.6" fill="#3b84d9" stroke="#1f5fae"/>', 22, 22);
  I.search = svg('<circle cx="8" cy="8" r="5.2" fill="none" stroke="#6f7983" stroke-width="1.8"/><path d="M12 12l5 5" stroke="#6f7983" stroke-width="2.2" stroke-linecap="round"/>', 22, 22);

  /* ---- plots ---- */
  I.pback = svg('<path d="M2 10l7-7v4.2h9v5.6H9V17z" fill="#d6e6f7" stroke="#b4cde8"/>', 26, 22);
  I.pfwd = svg('<path d="M18 10l-7-7v4.2H2v5.6h9V17z" fill="#d6e6f7" stroke="#b4cde8"/>', 26, 22);
  I.zoom = svg('<circle cx="8" cy="8" r="5.4" fill="#d6ecf7" stroke="#9fc4de" stroke-width="1.6"/><path d="M12 12l5 5" stroke="#d7c2a2" stroke-width="2.6" stroke-linecap="round"/><rect x="1.5" y="12.5" width="7" height="5" rx="1" fill="#eef1f4" stroke="#cfd5dc"/>', 26, 22);
  I.export = svg('<rect x="2.5" y="2.5" width="14" height="14" rx="1.4" fill="#fff" stroke="#8da7cf"/><path d="M4.5 12l2.4-3.4 2.6 2.2 2.4-4 2.4 5" fill="#b6c9e6" stroke="#5f7fb5"/><rect x="11" y="11" width="7" height="6.4" rx=".8" fill="#f1c747" stroke="#c99a1f"/><rect x="12.4" y="11.4" width="4.2" height="2.4" fill="#fff"/>', 24, 22);
  I.delcirc = svg('<circle cx="10" cy="10" r="7" fill="#fff" stroke="#e0464e" stroke-width="1.6"/><path d="M7 7l6 6M13 7l-6 6" stroke="#e0464e" stroke-width="1.8"/>', 22, 22);
  I.broomFaded = svg('<path d="M14.5 2.5l2.2 2-4.3 5.3-3-2.4z" fill="#c9b79e" stroke="#b09878"/><path d="M8.7 8.1l3 2.4c-.4 2.6-2 5-5.2 7.2-1.4.6-3-.4-3.6-.9 2.2-1.6 2.8-3.5 2.6-5.4z" fill="#e9dcb7" stroke="#cdbd92"/>', 22, 22);
  I.brush = svg('<path d="M15 3l2 2-6 7-3-2.4z" fill="#dfe3e8" stroke="#c4cad2"/><path d="M8 9.6l3 2.4c-.5 2.4-2.2 4-5 5.6-2-.5-2.6-1.4-3-2 2-1 2.6-2.4 2.4-4.4z" fill="#e5e8ec" stroke="#c4cad2"/>', 22, 22);
  I.shareFaded = svg('<path d="M9 4.5V2l7 6-7 6v-2.5C5 11.5 3 13.5 2 17c.4-5 3-8.4 7-8.5z" fill="#eef1f5" stroke="#c6ccd5"/>', 16, 16, '0 0 18 18');

  /* ---- misc ---- */
  I.caret = '<span class="ar"></span>';
  I.updown = svg('<path d="M1 4l3-3 3 3zM1 6l3 3 3-3z" fill="#6a6f75"/>', 8, 10, '0 0 8 10');
  I.zoomedOut = '';

  window.RI = {
    html: function (name) { return I[name] || ''; },
    el: function (name, size) {
      var s = document.createElement('span');
      s.className = 'ri ri-' + name;
      s.innerHTML = I[name] || '';
      if (size) { var v = s.firstChild; if (v && v.setAttribute) { v.setAttribute('width', size); v.setAttribute('height', size); } }
      return s;
    }
  };
})();
