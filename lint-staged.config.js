/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx,json,css,md}": "oxfmt",
  "*.{js,jsx,ts,tsx}": "oxlint --fix --deny-warnings",
};
