// ===== BOX CARD SHEET (Plan 5 Task 9) =====
// Render-only component: a fixed div that's hidden on screen and visible only
// under @media print (see styles.css). Listens for the global window event
// 'plan5:print-box-cards' (dispatched by ProductionTab) and reads
// `window.__BOX_CARD_PRINT_ROWS__` for the list of card image URLs. Then it
// populates the grid, defers two animation frames so React paints, and calls
// window.print(). The screen-side urls state is cleared after the dialog so
// the cards don't briefly flash on screen if the user cancels.
function BoxCardSheet() {
  const [urls, setUrls] = useState([]);

  useEffect(() => {
    function onPrint() {
      const list = window.__BOX_CARD_PRINT_ROWS__ || [];
      if (list.length === 0) return;
      setUrls(list);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.print();
        setTimeout(() => setUrls([]), 500);
      }));
    }
    window.addEventListener('plan5:print-box-cards', onPrint);
    return () => window.removeEventListener('plan5:print-box-cards', onPrint);
  }, []);

  if (urls.length === 0) return null;

  return <div className="box-card-sheet">
    {urls.map((u, i) => <div key={i} className="card" style={{backgroundImage: `url("${u}")`}}>
      <span className="cut-tl"/><span className="cut-tr"/><span className="cut-bl"/><span className="cut-br"/>
    </div>)}
  </div>;
}
