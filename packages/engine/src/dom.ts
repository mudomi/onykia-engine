/** Put `next` in place, touching only positions whose element changed. */
export function syncChildren(container: HTMLElement, next: Element[]): void {
  next.forEach((element, index) => {
    const current = container.children[index];
    if (current === element) return;
    if (current) current.replaceWith(element);
    else container.append(element);
  });
  while (container.children.length > next.length) container.lastElementChild?.remove();
}
