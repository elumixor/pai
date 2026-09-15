/**
 * Colour themes the way an editor has them: one set of colours for the chrome, one for
 * syntax, one for the terminal. Everything on screen reads from these, so a theme is the
 * whole look, not a light/dark switch.
 */
export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly kind: "light" | "dark";
  readonly ui: {
    readonly bg: string;
    readonly panel: string;
    readonly panel2: string;
    readonly line: string;
    readonly line2: string;
    readonly text: string;
    readonly dim: string;
    readonly accent: string;
    readonly accentInk: string;
    readonly busy: string;
    readonly idle: string;
    readonly warn: string;
    readonly hot: string;
    readonly codeBg: string;
    readonly selection: string;
  };
  readonly syntax: {
    readonly comment: string;
    readonly keyword: string;
    readonly string: string;
    readonly number: string;
    readonly function: string;
    readonly variable: string;
    readonly type: string;
    readonly property: string;
    readonly operator: string;
    readonly punctuation: string;
    readonly tag: string;
    readonly attribute: string;
    readonly constant: string;
    readonly heading: string;
    readonly link: string;
    readonly invalid: string;
  };
  readonly terminal: readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
}

const t = (
  id: string,
  name: string,
  kind: Theme["kind"],
  ui: Theme["ui"],
  syntax: Theme["syntax"],
  terminal: Theme["terminal"],
): Theme => ({ id, name, kind, ui, syntax, terminal });

export const THEMES: readonly Theme[] = [
  t(
    "pai-dark",
    "pai Dark",
    "dark",
    { bg: "#0b0d12", panel: "#11141b", panel2: "#161a23", line: "#1f2430", line2: "#2a3040", text: "#d6dae2", dim: "#7f8797", accent: "#8b9cff", accentInk: "#0b0d12", busy: "#e5b567", idle: "#7fd08a", warn: "#f2a25b", hot: "#f27d7d", codeBg: "#0d0f14", selection: "#2d3550" },
    { comment: "#5c6370", keyword: "#c678dd", string: "#98c379", number: "#d19a66", function: "#61afef", variable: "#e06c75", type: "#e5c07b", property: "#e06c75", operator: "#56b6c2", punctuation: "#abb2bf", tag: "#e06c75", attribute: "#d19a66", constant: "#d19a66", heading: "#e06c75", link: "#61afef", invalid: "#ff6c6b" },
    ["#0b0d12", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  ),
  t(
    "one-dark",
    "One Dark",
    "dark",
    { bg: "#21252b", panel: "#282c34", panel2: "#2c313a", line: "#3e4451", line2: "#4b5263", text: "#abb2bf", dim: "#7f848e", accent: "#61afef", accentInk: "#282c34", busy: "#e5c07b", idle: "#98c379", warn: "#d19a66", hot: "#e06c75", codeBg: "#282c34", selection: "#3e4451" },
    { comment: "#5c6370", keyword: "#c678dd", string: "#98c379", number: "#d19a66", function: "#61afef", variable: "#e06c75", type: "#e5c07b", property: "#e06c75", operator: "#56b6c2", punctuation: "#abb2bf", tag: "#e06c75", attribute: "#d19a66", constant: "#d19a66", heading: "#e06c75", link: "#61afef", invalid: "#ff6c6b" },
    ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  ),
  t(
    "dracula",
    "Dracula",
    "dark",
    { bg: "#21222c", panel: "#282a36", panel2: "#343746", line: "#3b3d4d", line2: "#44475a", text: "#f8f8f2", dim: "#6272a4", accent: "#bd93f9", accentInk: "#282a36", busy: "#f1fa8c", idle: "#50fa7b", warn: "#ffb86c", hot: "#ff5555", codeBg: "#282a36", selection: "#44475a" },
    { comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", function: "#50fa7b", variable: "#f8f8f2", type: "#8be9fd", property: "#66d9ef", operator: "#ff79c6", punctuation: "#f8f8f2", tag: "#ff79c6", attribute: "#50fa7b", constant: "#bd93f9", heading: "#bd93f9", link: "#8be9fd", invalid: "#ff5555" },
    ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  ),
  t(
    "nord",
    "Nord",
    "dark",
    { bg: "#242933", panel: "#2e3440", panel2: "#3b4252", line: "#3b4252", line2: "#434c5e", text: "#d8dee9", dim: "#7b88a1", accent: "#88c0d0", accentInk: "#2e3440", busy: "#ebcb8b", idle: "#a3be8c", warn: "#d08770", hot: "#bf616a", codeBg: "#2e3440", selection: "#434c5e" },
    { comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", function: "#88c0d0", variable: "#d8dee9", type: "#8fbcbb", property: "#88c0d0", operator: "#81a1c1", punctuation: "#eceff4", tag: "#81a1c1", attribute: "#8fbcbb", constant: "#b48ead", heading: "#88c0d0", link: "#5e81ac", invalid: "#bf616a" },
    ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  ),
  t(
    "tokyo-night",
    "Tokyo Night",
    "dark",
    { bg: "#16161e", panel: "#1a1b26", panel2: "#1f2335", line: "#292e42", line2: "#3b4261", text: "#c0caf5", dim: "#565f89", accent: "#7aa2f7", accentInk: "#1a1b26", busy: "#e0af68", idle: "#9ece6a", warn: "#ff9e64", hot: "#f7768e", codeBg: "#1a1b26", selection: "#283457" },
    { comment: "#565f89", keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", function: "#7aa2f7", variable: "#c0caf5", type: "#2ac3de", property: "#73daca", operator: "#89ddff", punctuation: "#a9b1d6", tag: "#f7768e", attribute: "#bb9af7", constant: "#ff9e64", heading: "#7aa2f7", link: "#73daca", invalid: "#f7768e" },
    ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  ),
  t(
    "catppuccin-mocha",
    "Catppuccin Mocha",
    "dark",
    { bg: "#181825", panel: "#1e1e2e", panel2: "#313244", line: "#313244", line2: "#45475a", text: "#cdd6f4", dim: "#7f849c", accent: "#cba6f7", accentInk: "#1e1e2e", busy: "#f9e2af", idle: "#a6e3a1", warn: "#fab387", hot: "#f38ba8", codeBg: "#1e1e2e", selection: "#45475a" },
    { comment: "#6c7086", keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", function: "#89b4fa", variable: "#cdd6f4", type: "#f9e2af", property: "#94e2d5", operator: "#89dceb", punctuation: "#9399b2", tag: "#f38ba8", attribute: "#f9e2af", constant: "#fab387", heading: "#f38ba8", link: "#89b4fa", invalid: "#f38ba8" },
    ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
  ),
  t(
    "gruvbox-dark",
    "Gruvbox Dark",
    "dark",
    { bg: "#1d2021", panel: "#282828", panel2: "#32302f", line: "#3c3836", line2: "#504945", text: "#ebdbb2", dim: "#928374", accent: "#fabd2f", accentInk: "#282828", busy: "#fabd2f", idle: "#b8bb26", warn: "#fe8019", hot: "#fb4934", codeBg: "#282828", selection: "#504945" },
    { comment: "#928374", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", function: "#fabd2f", variable: "#ebdbb2", type: "#fabd2f", property: "#83a598", operator: "#fe8019", punctuation: "#ebdbb2", tag: "#8ec07c", attribute: "#fabd2f", constant: "#d3869b", heading: "#b8bb26", link: "#83a598", invalid: "#fb4934" },
    ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  ),
  t(
    "pai-light",
    "pai Light",
    "light",
    { bg: "#f3f4f8", panel: "#ffffff", panel2: "#f7f8fb", line: "#e4e7ee", line2: "#d3d8e3", text: "#1d2230", dim: "#6b7382", accent: "#4a5bd6", accentInk: "#ffffff", busy: "#c98a1c", idle: "#2f9e57", warn: "#d9781a", hot: "#d9433f", codeBg: "#fbfbfd", selection: "#d4dafc" },
    { comment: "#8a919e", keyword: "#a626a4", string: "#50a14f", number: "#986801", function: "#4078f2", variable: "#e45649", type: "#c18401", property: "#e45649", operator: "#0184bc", punctuation: "#383a42", tag: "#e45649", attribute: "#986801", constant: "#986801", heading: "#e45649", link: "#4078f2", invalid: "#e45649" },
    ["#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7", "#4f525e", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#fafafa"],
  ),
  t(
    "github-light",
    "GitHub Light",
    "light",
    { bg: "#f6f8fa", panel: "#ffffff", panel2: "#f6f8fa", line: "#d0d7de", line2: "#c4ccd4", text: "#1f2328", dim: "#656d76", accent: "#0969da", accentInk: "#ffffff", busy: "#bf8700", idle: "#1a7f37", warn: "#bc4c00", hot: "#cf222e", codeBg: "#ffffff", selection: "#ddf4ff" },
    { comment: "#6e7781", keyword: "#cf222e", string: "#0a3069", number: "#0550ae", function: "#8250df", variable: "#953800", type: "#953800", property: "#0550ae", operator: "#cf222e", punctuation: "#24292f", tag: "#116329", attribute: "#0550ae", constant: "#0550ae", heading: "#0550ae", link: "#0a3069", invalid: "#82071e" },
    ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"],
  ),
  t(
    "solarized-light",
    "Solarized Light",
    "light",
    { bg: "#eee8d5", panel: "#fdf6e3", panel2: "#f5efdc", line: "#e3dcc6", line2: "#d3ccb4", text: "#586e75", dim: "#93a1a1", accent: "#268bd2", accentInk: "#fdf6e3", busy: "#b58900", idle: "#859900", warn: "#cb4b16", hot: "#dc322f", codeBg: "#fdf6e3", selection: "#e6dfc8" },
    { comment: "#93a1a1", keyword: "#859900", string: "#2aa198", number: "#d33682", function: "#268bd2", variable: "#268bd2", type: "#b58900", property: "#268bd2", operator: "#859900", punctuation: "#586e75", tag: "#268bd2", attribute: "#93a1a1", constant: "#cb4b16", heading: "#cb4b16", link: "#2aa198", invalid: "#dc322f" },
    ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  ),
  t(
    "catppuccin-latte",
    "Catppuccin Latte",
    "light",
    { bg: "#e6e9ef", panel: "#eff1f5", panel2: "#e6e9ef", line: "#ccd0da", line2: "#bcc0cc", text: "#4c4f69", dim: "#8c8fa1", accent: "#8839ef", accentInk: "#eff1f5", busy: "#df8e1d", idle: "#40a02b", warn: "#fe640b", hot: "#d20f39", codeBg: "#eff1f5", selection: "#ccd0da" },
    { comment: "#9ca0b0", keyword: "#8839ef", string: "#40a02b", number: "#fe640b", function: "#1e66f5", variable: "#4c4f69", type: "#df8e1d", property: "#179299", operator: "#04a5e5", punctuation: "#7c7f93", tag: "#d20f39", attribute: "#df8e1d", constant: "#fe640b", heading: "#d20f39", link: "#1e66f5", invalid: "#d20f39" },
    ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"],
  ),
];

export const themeById = (id: string) => THEMES.find((theme) => theme.id === id);
