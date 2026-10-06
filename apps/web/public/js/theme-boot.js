/* Applies the saved theme before first paint, so a saved choice never flashes
   the default, and sets the browser bar to match. A classic script (not a
   module), placed in <head> right AFTER the themes.css link, so the browser
   has the theme colours when it runs:

     <link rel="stylesheet" href="css/themes.css">
     <script src="js/theme-boot.js" data-theme-key="<product>.theme"></script>

   ?theme=<id> in the address applies that theme for this page load only.
   Storage can be blocked; then the page follows the device. */
(function bootTheme() {
  var ids = ['auto', 'light', 'dark', 'classic', 'contrast'];
  var script = document.currentScript;
  var key = (script && script.getAttribute('data-theme-key')) || 'theme';
  var id = null;
  try {
    var asked = new URLSearchParams(window.location.search).get('theme');
    id = ids.indexOf(asked) >= 0 ? asked : window.localStorage.getItem(key);
  } catch (err) {
    id = null;
  }
  if (id && id !== 'auto' && ids.indexOf(id) >= 0) document.documentElement.setAttribute('data-theme', id);
  try {
    var chrome = window.getComputedStyle(document.documentElement).getPropertyValue('--theme-chrome').trim();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (chrome && meta) meta.setAttribute('content', chrome);
  } catch (err) {
    // theme.mjs sets the bar once it runs.
  }
}());
