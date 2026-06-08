# Owen Exporter

![Owen Exporter SVG download menu](screenshot/svgtodown.png)

![Owen Exporter Markdown to HTML menu](screenshot/mdtohtml.png)

Owen Exporter is an Obsidian plugin for two export workflows:

- Right-click an embedded SVG image and download it as PNG or JPEG.
- Select Markdown content, then copy it as rendered HTML or save it as an HTML file.

## Features

### SVG image export

In reading mode, right-click an embedded SVG image. Owen Exporter adds menu items to export the SVG as the default image format or the alternate format.

Settings include:

- Default output format: PNG or JPEG
- JPEG quality
- Rasterization scale for higher-resolution output
- Background color for JPEG or transparent SVGs

Exports open a local save dialog so you can choose any PC folder. If the native save dialog is unavailable, the plugin falls back to the browser download flow.

### Markdown selection to HTML

In source mode, select Markdown text and right-click to access:

- Copy selection as HTML
- Save selection as HTML file

The same actions are available as commands so users can assign or change hotkeys in Obsidian settings. Default hotkeys are:

- Copy selected Markdown as HTML: `Ctrl/Cmd+Shift+H`
- Save selected Markdown as HTML file: `Ctrl/Cmd+Shift+Alt+H`

Reading mode text selections are also supported through the browser selection context menu. In that mode the plugin copies or saves the selected rendered HTML fragment.

Table, code block, and callout exports include inline styles copied from the active Obsidian preview so the pasted or saved HTML keeps the Live Preview look more closely.

## Development

```powershell
npm install
npm run build
```

For local Obsidian testing, copy or symlink `manifest.json`, `main.js`, and optionally `styles.css` into a vault plugin folder such as:

```text
<vault>/.obsidian/plugins/owen-exporter/
```
