// Applies the saved System / Light / Dark choice before the first paint. Anything but "light" or
// "dark" leaves the system preference in charge. A ?theme=light or ?theme=dark on the URL wins
// for that one page load (review links and screenshots) and is never saved.
// Also applies the hide-amounts choice (the eye in the top bar), so a hidden amount never shows
// for a moment before the page's script runs.
(function () {
  try {
    var asked = new URLSearchParams(window.location.search).get("theme");
    var theme = asked === "light" || asked === "dark" ? asked : window.localStorage.getItem("pc-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch (e) {
    // Storage blocked: the system preference stays in charge.
  }
  try {
    if (window.localStorage.getItem("pc-amounts") === "hidden") document.documentElement.dataset.amounts = "hidden";
  } catch (e) {
    // Storage blocked: amounts show, as they do by default.
  }
})();
