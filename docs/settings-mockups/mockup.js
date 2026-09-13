// Mockup harness. Reads ?github=&slack=&viewer= (or the hash), shows only the
// elements whose data-when matches, and renders the control bar. Not design.
(function () {
  var DIMS = {
    github: ["connected", "never", "disconnected"],
    slack: ["connected", "never", "disconnected", "unavailable"],
    viewer: ["admin", "member"],
    theme: ["day", "night"]
  };
  var LABELS = { github: "GitHub", slack: "Slack", viewer: "Viewer", theme: "Theme" };
  var state = {};
  var params = new URLSearchParams(location.search);
  Object.keys(DIMS).forEach(function (k) {
    var v = params.get(k);
    state[k] = DIMS[k].indexOf(v) >= 0 ? v : DIMS[k][0];
  });

  function matches(spec) {
    return spec.split(";").every(function (clause) {
      var parts = clause.split("=");
      if (parts.length !== 2) return true;
      var key = parts[0].trim();
      var allowed = parts[1].split(",").map(function (s) { return s.trim(); });
      return allowed.indexOf(state[key]) >= 0;
    });
  }
  function apply() {
    document.querySelectorAll("[data-when]").forEach(function (el) {
      el.hidden = !matches(el.getAttribute("data-when"));
    });
    document.querySelectorAll("[data-checked-when]").forEach(function (el) {
      el.checked = matches(el.getAttribute("data-checked-when"));
    });
    document.querySelectorAll("[data-disabled-when]").forEach(function (el) {
      el.disabled = matches(el.getAttribute("data-disabled-when"));
    });
    document.documentElement.setAttribute("data-viewer", state.viewer);
    document.documentElement.classList.toggle("dark", state.theme === "night");
  }
  function navigate() {
    var q = new URLSearchParams(state).toString();
    history.replaceState(null, "", location.pathname + "?" + q + location.hash);
    apply();
  }
  function bar() {
    var b = document.createElement("div");
    b.className = "mock-bar";
    var title = document.createElement("strong");
    title.textContent = document.title + " — mockup controls (not part of the design)";
    b.appendChild(title);
    Object.keys(DIMS).forEach(function (k) {
      var l = document.createElement("label");
      l.textContent = LABELS[k] + " ";
      var s = document.createElement("select");
      DIMS[k].forEach(function (v) {
        var o = document.createElement("option");
        o.value = v; o.textContent = v; o.selected = state[k] === v;
        s.appendChild(o);
      });
      s.addEventListener("change", function () { state[k] = s.value; navigate(); });
      l.appendChild(s);
      b.appendChild(l);
    });
    var back = document.createElement("a");
    back.href = "index.html"; back.textContent = "All mockups";
    b.appendChild(back);
    document.body.insertBefore(b, document.body.firstChild);
  }
  document.addEventListener("DOMContentLoaded", function () { bar(); apply(); });
})();
