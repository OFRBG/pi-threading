// Entry point declared in package.json's `pi.extensions` — kept at the
// package root (not `src/`) because pi's extension loader derives a
// display name from the entry file's containing directory; a root-level
// entry makes that directory the package name instead of "src".
export { default } from "./src/index";
