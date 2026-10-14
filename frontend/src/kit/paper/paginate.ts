export interface PageCapacity { first: number; next: number; lastReserve: number }

/** Row indexes per page. A row is never split; the last page keeps `lastReserve` px free for totals + signatures. */
export function paginate(rowHeights: number[], cap: PageCapacity): number[][] {
  const pages: number[][] = [[]];
  let used = 0;
  const capOf = (p: number) => (p === 0 ? cap.first : cap.next);
  rowHeights.forEach((h, i) => {
    const p = pages.length - 1;
    if (used + h > capOf(p) && pages[p].length > 0) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(i);
    used += h;
  });
  const p = pages.length - 1;
  if (used + cap.lastReserve > capOf(p)) {
    // The totals do not fit under the last rows: carry the trailing rows over to the totals page (keep >= 1 row behind),
    // else (a lone tall row, or the carried rows would not fit either) the totals get a page of their own.
    const rows = pages[p];
    let u = used, moved = 0, take = 0;
    while (rows.length - take > 1 && u + cap.lastReserve > capOf(p)) { const h = rowHeights[rows[rows.length - 1 - take]]; u -= h; moved += h; take++; }
    if (take > 0 && u + cap.lastReserve <= capOf(p) && moved + cap.lastReserve <= cap.next) pages.push(rows.splice(rows.length - take));
    else pages.push([]);
  }
  return pages;
}
