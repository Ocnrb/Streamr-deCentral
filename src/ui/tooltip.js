// The custom tooltip (data-tooltip-content), always written as text

export const customTooltip = document.getElementById('custom-tooltip');

/**
 * Sets the custom tooltip's content. Values never break across lines: the spaces inside numbers
 * ("4 936 930") and before their unit ("930 DATA") become non-breaking, so when the text doesn't fit
 * the whole value moves to the next line.
 * @param {string} content - text, or HTML when it contains <br>
 */
/**
 * Writes the tooltip as text, never as HTML: tooltip texts often hold outside data (operator descriptions, stream ids)
 * and a data-tooltip-content attribute comes back unescaped from dataset. Only two marks are kept: "<br>" starts a
 * new line, and a line starting with <span class='font-semibold'>...</span> shows that part in bold (both as text).
 */
export function setTooltipContent(content) {
    if (!customTooltip) return;
    const keepTogether = (text) => String(text)
        .replace(/(\d) (?=\d)/g, '$1\u00A0')
        .replace(/(\d) (?=(DATA|POL|USD|%)\b)/g, '$1\u00A0');
    const bold = /^<span class=['"]font-semibold['"]>([\s\S]*?)<\/span>([\s\S]*)$/;
    const nodes = [];
    String(content).split(/<br\s*\/?>/i).forEach((line, i) => {
        if (i) nodes.push(document.createElement('br'));
        const match = bold.exec(line);
        if (match) {
            const strong = document.createElement('span');
            strong.className = 'font-semibold';
            strong.textContent = keepTogether(match[1]);
            nodes.push(strong, document.createTextNode(keepTogether(match[2])));
        } else {
            nodes.push(document.createTextNode(keepTogether(line)));
        }
    });
    customTooltip.replaceChildren(...nodes);
}

/**
 * Positions the custom tooltip next to the pointer, inside the viewport: it opens to the left / above
 * the pointer when there is no room to the right / below.
 */
export function positionTooltip(e) {
    if (!customTooltip || customTooltip.classList.contains('hidden')) return;
    const gap = 15;
    const margin = 8;
    const width = customTooltip.offsetWidth;
    const height = customTooltip.offsetHeight;
    const viewportRight = window.scrollX + document.documentElement.clientWidth;
    const viewportBottom = window.scrollY + document.documentElement.clientHeight;
    let left = e.pageX + gap;
    let top = e.pageY + gap;
    if (left + width + margin > viewportRight) left = Math.max(window.scrollX + margin, e.pageX - gap - width);
    if (top + height + margin > viewportBottom) top = Math.max(window.scrollY + margin, e.pageY - gap - height);
    customTooltip.style.left = `${left}px`;
    customTooltip.style.top = `${top}px`;
}
