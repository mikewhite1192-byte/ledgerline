// Applies the saved System / Light / Dark choice before the first paint. Anything but "light" or
// "dark" leaves the system preference in charge. A ?theme=light or ?theme=dark on the URL wins
// for that one page load (review links and screenshots) and is never saved.
(function () {
  try {
    var asked = new URLSearchParams(window.location.search).get("theme");
    var theme = asked === "light" || asked === "dark" ? asked : window.localStorage.getItem("pc-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch (e) {
    // Storage blocked: the system preference stays in charge.
  }
})();
