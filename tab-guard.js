(() => {
  const EDITABLE_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable=\"false\"])",
    "[role=\"textbox\"]"
  ].join(",");
  const baselineValues = new WeakMap();
  const settingsKey = "smartSleepSettings";
  let enabled = false;
  let listenersAttached = false;

  function controls() {
    return [...document.querySelectorAll(EDITABLE_SELECTOR)];
  }

  function valueOf(control) {
    if (control instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(control.type)) {
        return `checked:${control.checked}`;
      }
      if (control.type === "file") return `files:${control.files?.length || 0}`;
      return `value:${control.value}`;
    }
    if (control instanceof HTMLTextAreaElement) return `value:${control.value}`;
    if (control instanceof HTMLSelectElement) {
      return `selected:${[...control.selectedOptions].map((option) => option.value).join("\u0000")}`;
    }
    return `content:${control.textContent || ""}`;
  }

  function reportFormState() {
    if (!enabled) return;
    const editableControls = controls();
    editableControls.forEach((control) => {
      if (!baselineValues.has(control)) baselineValues.set(control, valueOf(control));
    });

    const activeElement = document.activeElement;
    const activeForm = document.hasFocus()
      && editableControls.some((control) => control === activeElement);
    const changedForm = editableControls.some((control) =>
      valueOf(control) !== baselineValues.get(control)
    );
    chrome.runtime.sendMessage({
      type: "FORM_STATE",
      protected: activeForm || changedForm
    }).catch(() => {});
  }

  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    ["input", "change", "focusin", "focusout", "beforeinput", "paste", "drop"]
      .forEach((eventName) => {
        document.addEventListener(eventName, () => {
          setTimeout(reportFormState, 0);
        }, true);
      });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", reportFormState, { once: true });
    } else {
      reportFormState();
    }
  }

  function updateEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    if (enabled) attachListeners();
  }

  chrome.storage.local.get(settingsKey).then((state) => {
    updateEnabled(state?.[settingsKey]?.enabled);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[settingsKey]) return;
    updateEnabled(changes[settingsKey].newValue?.enabled);
  });
})();
