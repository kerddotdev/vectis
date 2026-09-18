export function codeLines(html: string) {
  return html
    .split("\n")
    .map((line, index) => `<span class="line" style="--i:${index}">${line}</span>`)
    .join("");
}
