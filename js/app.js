// app.js — shared utilities and future router entry point

/**
 * Highlight the current page in the nav.
 */
(function highlightActiveNav() {
  const links = document.querySelectorAll('.navbar ul a');
  links.forEach(link => {
    if (link.href === window.location.href) {
      link.classList.add('active');
    }
  });
})();
