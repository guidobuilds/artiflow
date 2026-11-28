export const artboardControllerScript = (): string => `
"use strict";
var selectorOf = function (target) {
  return target !== null && typeof target === "object" && typeof target.closest === "function" ? target : null;
};
document.addEventListener("click", function (event) {
  var target = selectorOf(event.target);
  var button = target === null ? null : target.closest(".scene-artboard-width");
  if (button === null) return;
  var frame = button.closest("[data-frame-id]");
  var viewport = button.getAttribute("data-artboard-width");
  if (frame === null || viewport === null || !/^[0-9]+$/.test(viewport)) return;
  var inner = frame.querySelector(".scene-artboard-frame");
  if (inner !== null) inner.style.width = viewport + "px";
  var controls = frame.querySelectorAll(".scene-artboard-width");
  for (var index = 0; index < controls.length; index += 1) {
    var width = controls[index].getAttribute("data-artboard-width");
    controls[index].setAttribute("aria-pressed", width === viewport ? "true" : "false");
  }
});
`;
