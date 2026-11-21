/** A keyboard-accessible confirmation shared by all TownSeeker pages. */
export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "townseeker-confirmation";
    const title = document.createElement("h2");
    title.id = "townseeker-confirmation-title";
    title.textContent = "Confirm action";
    const description = document.createElement("p");
    description.id = "townseeker-confirmation-message";
    description.textContent = message;
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.setAttribute("aria-describedby", description.id);
    const actions = document.createElement("div");
    actions.className = "townseeker-confirmation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "confirmation-cancel";
    cancel.textContent = "Cancel";
    cancel.autofocus = true;
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "Confirm";
    cancel.addEventListener("click", () => dialog.close("cancel"));
    confirm.addEventListener("click", () => dialog.close("confirm"));
    dialog.addEventListener(
      "close",
      () => {
        const accepted = dialog.returnValue === "confirm";
        dialog.remove();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus();
        resolve(accepted);
      },
      { once: true },
    );
    actions.append(cancel, confirm);
    dialog.append(title, description, actions);
    document.body.append(dialog);
    dialog.showModal();
  });
}
