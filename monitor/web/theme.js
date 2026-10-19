// Applies the saved theme before the page draws, so dark mode never flashes light.
(function () {
  var choice = 'auto';
  try { choice = localStorage.getItem('monitor-theme') || 'auto'; } catch (e) {}
  var dark = choice === 'dark' || (choice === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = choice;
})();
