// ==UserScript==
// @name         mutuals-mapper
// @namespace    https://github.com/andypeterson2/mutual-mapper
// @version      0.1.3
// @description  Map your X/Twitter mutuals network entirely in the browser
// @author       Andy Peterson
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/andypeterson2/mutual-mapper/main/dist/mutuals-mapper.user.js
// @downloadURL  https://raw.githubusercontent.com/andypeterson2/mutual-mapper/main/dist/mutuals-mapper.user.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://d3js.org/d3.v7.min.js
// @require      https://cdn.jsdelivr.net/npm/graphology@0.25.4/dist/graphology.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/graphology-communities-louvain@2.0.1/dist/graphology-communities-louvain.umd.min.js
// ==/UserScript==

/* eslint-disable no-undef */
"use strict";
