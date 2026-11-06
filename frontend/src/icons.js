const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  stable: "M4 21V8l8-5 8 5v13M8 21v-8h8v8M3 21h18M10 8h4",
  flag: "M5 22V3m0 1c5-4 9 4 14 0v11c-5 4-9-4-14 0",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  shop: "M3 9h18l-2-6H5ZM4 9v12h16V9M9 21v-7h6v7M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  coin: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5 3 4-3 4-3-4Z",
  bell: "M5 16h14l-2-3V9a5 5 0 0 0-10 0v4Zm5 4h4",
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9.5 9a2.5 2.5 0 1 1 4 2c-1 .5-1.5 1-1.5 2m0 3h.01",
  laurel:
    "M5 4c-5 7-3 13 3 16m11-16c5 7 3 13-3 16M3 8l4 2M2 13l5 1m-3 4 4-1M21 8l-4 2m5 3-5 1m3 4-4-1M9 21h6",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c5 5 5 13 0 18-5-5-5-13 0-18ZM3 12h18",
  rotate: "M3 10a9 9 0 1 1 2 9M3 4v6h6",
  bolt: "m13 2-8 12h6l-1 8 9-13h-6Z",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm5.5 13 5 5",
  close: "m5 5 14 14M5 19 19 5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
};
export const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.spark}"/></svg>`;
