// Shared behavior across every page: header shadow on scroll, sidebar drawer.
(function () {
  var header = document.getElementById("siteHeader");
  var onScroll = function () {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var menuToggle = document.getElementById("menuToggle");
  var sidebar = document.getElementById("sidebar");
  var overlay = document.getElementById("sidebarOverlay");
  var closeBtn = document.getElementById("sidebarClose");

  function openSidebar() {
    sidebar.classList.add("is-open");
    overlay.classList.add("is-open");
    sidebar.setAttribute("aria-hidden", "false");
    menuToggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("sidebar-open");
  }
  function closeSidebar() {
    sidebar.classList.remove("is-open");
    overlay.classList.remove("is-open");
    sidebar.setAttribute("aria-hidden", "true");
    menuToggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("sidebar-open");
  }
  if (menuToggle && sidebar) {
    menuToggle.addEventListener("click", function () {
      var isOpen = sidebar.classList.contains("is-open");
      isOpen ? closeSidebar() : openSidebar();
    });
    overlay.addEventListener("click", closeSidebar);
    closeBtn.addEventListener("click", closeSidebar);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeSidebar();
    });
  }

  var year = document.getElementById("footerYear");
  if (year) year.textContent = new Date().getFullYear();
})();
