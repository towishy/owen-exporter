import { setIcon, type Setting } from "obsidian";

const tones: Record<string, string> = {
  languages: "sky", interface: "sky", toolbar: "mint", "panel-top": "mint",
  "image-down": "teal", "file-code": "violet", workflow: "amber",
  "archive-restore": "rose", graphite: "amber", favorites: "rose",
  "zoom-in": "violet", star: "rose", sparkles: "amber",
};
let detailId = 0;
let dropdownId = 0;

export function styleSettingsHeading(element: HTMLElement, section: string): void {
  element.addClass("owen-settings-heading");
  element.dataset.owenTone = tones[section] || "violet";
}

function enhanceSettingsDropdown(select: HTMLSelectElement, label: string): void {
  if (select.multiple || select.dataset.owenSettingsDropdown) return;
  const document = select.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const id = `owen-exporter-settings-dropdown-${++dropdownId}`;
  const menu = document.createElement("div");
  menu.id = id;
  menu.className = "owen-settings-dropdown-popover";
  menu.setAttribute("popover", "manual");
  menu.setAttribute("role", "listbox");
  if (label) menu.setAttribute("aria-label", label);

  let activeIndex = select.selectedIndex;
  let rows: HTMLDivElement[] = [];
  let typeahead = "";
  let typeaheadTimer = 0;
  let listeningForPosition = false;
  let listeningForDismissal = false;
  const isOpen = () => menu.matches(":popover-open");
  const options = () => Array.from(select.options);

  const refreshOptions = () => {
    const currentOptions = options();
    if (currentOptions.length !== rows.length) {
      rows = currentOptions.map((_option, index) => {
        const row = document.createElement("div");
        row.id = `${id}-option-${index}`;
        row.className = "owen-settings-dropdown-option";
        row.setAttribute("role", "option");
        row.addEventListener("pointerdown", (event) => event.preventDefault());
        row.addEventListener("click", (event) => {
          event.preventDefault();
          if (!options()[index]?.disabled) commit(index);
        });
        const text = document.createElement("span");
        text.className = "owen-settings-dropdown-label";
        const check = document.createElement("span");
        check.className = "owen-settings-dropdown-check";
        check.setAttribute("aria-hidden", "true");
        setIcon(check, "check");
        row.append(text, check);
        return row;
      });
      menu.replaceChildren(...rows);
    }
    currentOptions.forEach((option, index) => {
      const row = rows[index];
      const text = row.querySelector(".owen-settings-dropdown-label");
      const labelText = option.label || option.textContent || "";
      if (text && text.textContent !== labelText) text.textContent = labelText;
      row.classList.toggle("is-selected", option.selected);
      row.classList.toggle("is-disabled", option.disabled);
      row.setAttribute("aria-selected", String(option.selected));
      row.setAttribute("aria-disabled", String(option.disabled));
    });
    if (isOpen()) setActive(activeIndex);
  };

  const updatePosition = () => {
    const rect = select.getBoundingClientRect();
    const measureContext = document.createElement("canvas").getContext("2d");
    const widestLabel = options().reduce((widest, option, index) => {
      if (!measureContext) return widest;
      const rowStyle = view.getComputedStyle(rows[index] ?? menu);
      measureContext.font = rowStyle.font || `${rowStyle.fontSize} ${rowStyle.fontFamily}`;
      return Math.max(widest, measureContext.measureText(option.label || option.textContent || "").width);
    }, 0);
    const contentWidth = Math.ceil(widestLabel + 64);
    const width = Math.min(Math.max(180, rect.width, contentWidth), view.innerWidth - 16);
    const itemHeight = 44;
    const desiredHeight = Math.min(options().length * itemHeight + 12, 320);
    const below = view.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const openBelow = below >= Math.min(desiredHeight, 132) || below >= above;
    const available = Math.max(48, Math.min(desiredHeight, openBelow ? below : above));
    const left = Math.max(8, Math.min(rect.left, view.innerWidth - width - 8));
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${available}px`;
    menu.style.top = openBelow ? `${rect.bottom + 4}px` : `${Math.max(8, rect.top - available - 4)}px`;
  };

  const setActive = (index: number): void => {
    const currentOptions = options();
    if (!currentOptions.length) {
      select.removeAttribute("aria-activedescendant");
      return;
    }
    let candidate = Number.isInteger(index) && index >= 0 && index < currentOptions.length
      ? index
      : currentOptions.findIndex((option) => !option.disabled);
    if (candidate < 0) {
      rows.forEach((row) => row.classList.remove("is-active"));
      select.removeAttribute("aria-activedescendant");
      return;
    }
    for (let offset = 0; offset < currentOptions.length && currentOptions[candidate]?.disabled; offset += 1) {
      candidate = (candidate + 1) % currentOptions.length;
    }
    if (currentOptions[candidate]?.disabled) return;
    activeIndex = candidate;
    rows.forEach((row, rowIndex) => row.classList.toggle("is-active", rowIndex === activeIndex));
    const activeRow = rows[activeIndex];
    if (activeRow) {
      select.setAttribute("aria-activedescendant", activeRow.id);
      activeRow.scrollIntoView({ block: "nearest" });
    }
  };

  const close = () => {
    if (isOpen()) menu.hidePopover();
    select.setAttribute("aria-expanded", "false");
    select.removeAttribute("aria-activedescendant");
    view.clearTimeout(typeaheadTimer);
    typeahead = "";
    if (listeningForDismissal) {
      document.removeEventListener("pointerdown", dismissOutside);
      listeningForDismissal = false;
    }
    if (listeningForPosition) {
      view.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      listeningForPosition = false;
    }
  };

  const dismissOutside = (event: PointerEvent) => {
    const path = event.composedPath();
    if (!path.includes(select) && !path.includes(menu)) close();
  };

  const open = () => {
    if (select.disabled || isOpen()) return;
    activeIndex = select.selectedIndex;
    if (currentDisabled()) activeIndex = options().findIndex((option) => !option.disabled);
    refreshOptions();
    updatePosition();
    menu.showPopover();
    select.setAttribute("aria-expanded", "true");
    setActive(activeIndex);
    if (!listeningForDismissal) {
      document.addEventListener("pointerdown", dismissOutside);
      listeningForDismissal = true;
    }
    if (!listeningForPosition) {
      view.addEventListener("resize", updatePosition);
      document.addEventListener("scroll", updatePosition, true);
      listeningForPosition = true;
    }
  };

  function currentDisabled(): boolean {
    return Boolean(options()[activeIndex]?.disabled);
  }

  const commit = (index: number) => {
    const option = options()[index];
    if (!option || option.disabled) return;
    if (select.selectedIndex !== index) {
      select.selectedIndex = index;
      select.dispatchEvent(new view.Event("input", { bubbles: true }));
      select.dispatchEvent(new view.Event("change", { bubbles: true }));
    }
    close();
    select.focus();
  };

  const moveActive = (direction: number) => {
    const currentOptions = options();
    if (!currentOptions.length) return;
    let index = activeIndex;
    for (let offset = 0; offset < currentOptions.length; offset += 1) {
      index = (index + direction + currentOptions.length) % currentOptions.length;
      if (!currentOptions[index].disabled) {
        setActive(index);
        return;
      }
    }
  };

  refreshOptions();
  select.dataset.owenSettingsDropdown = id;
  select.setAttribute("aria-haspopup", "listbox");
  select.setAttribute("aria-controls", id);
  select.setAttribute("aria-expanded", "false");
  select.insertAdjacentElement("afterend", menu);
  menu.addEventListener("toggle", () => {
    if (!isOpen()) close();
  });
  select.addEventListener("change", refreshOptions);
  select.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || (event.button !== 0 && event.pointerType !== "touch")) return;
    event.preventDefault();
    select.focus();
    if (isOpen()) close();
    else open();
  });
  select.addEventListener("click", (event) => event.preventDefault());
  select.addEventListener("keydown", (event) => {
    if (!isOpen()) {
      if ((event.altKey && event.key === "ArrowDown") || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
      return;
    }
    if (event.key === "Escape" || (event.altKey && event.key === "ArrowUp")) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End" || event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      if (event.key === "Home") setActive(0);
      else if (event.key === "End") setActive(options().length - 1);
      else moveActive((event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1) * (event.key.startsWith("Page") ? 5 : 1));
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      typeahead = `${typeahead}${event.key}`.toLocaleLowerCase();
      view.clearTimeout(typeaheadTimer);
      typeaheadTimer = view.setTimeout(() => { typeahead = ""; }, 700);
      const match = options().findIndex((option) => !option.disabled && (option.label || option.textContent || "").toLocaleLowerCase().startsWith(typeahead));
      if (match >= 0) {
        event.preventDefault();
        setActive(match);
      }
    }
  });
}

export function styleSettingsRow(setting: Setting): void {
  setting.settingEl.classList.add("owen-settings-row");
  setting.settingEl.closest(".vertical-tab-content")?.classList.add("owen-settings-design");
  const select = setting.controlEl.querySelector("select");
  if (select) enhanceSettingsDropdown(select, setting.nameEl.textContent?.trim() || "");
  // Text field instructions, warnings and rich descriptions remain visible.
  const description = setting.descEl;
  if (!setting.controlEl.querySelector("select, .checkbox-container") || !description.textContent?.trim() || description.children.length || setting.settingEl.classList.contains("setting-item-heading")) return;
  if (setting.nameEl.querySelector(".owen-settings-help")) return;
  const text = description.textContent.trim();
  const id = `owen-settings-detail-${++detailId}`;
  description.id = id;
  description.setAttribute("popover", "auto");
  description.classList.add("owen-settings-detail");
  const button = setting.nameEl.createEl("button", {
    cls: "owen-settings-help",
    attr: { type: "button", "aria-label": `${setting.nameEl.textContent}: ${text}`, popovertarget: id },
  });
  setIcon(button, "info");
}
