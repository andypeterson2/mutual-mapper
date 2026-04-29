// ==UserScript==
// @name         mutuals-mapper
// @namespace    https://github.com/andypeterson2/mutuals-mapper-userscript
// @version      0.1.2
// @description  Map your X/Twitter mutuals network entirely in the browser
// @author       Andy Peterson
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://gist.githubusercontent.com/andypeterson2/d7557ecb5c9f0a263896779cc06c037d/raw/mutuals-mapper.user.js
// @downloadURL  https://gist.githubusercontent.com/andypeterson2/d7557ecb5c9f0a263896779cc06c037d/raw/mutuals-mapper.user.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://d3js.org/d3.v7.min.js
// @require      https://cdn.jsdelivr.net/npm/graphology@0.25.4/dist/graphology.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/graphology-communities-louvain@2.0.1/dist/graphology-communities-louvain.umd.min.js
// ==/UserScript==

/* eslint-disable no-undef */
"use strict";
