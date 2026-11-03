// 1 · The hook, logical cut: "Your data model, as a diagram, saved as plain files in your repo. /
// No AI, and nothing to configure." The shared hook scene (../hook.js) on a plain folder: its
// .erd-studio tree holds one .dbml file per table (the 2.0 layer-first layout:
// <layer>/tables/<schema>/<name>.dbml, <layer>/diagrams/<name>.dbml), and those table files fly
// into three nodes on "…as a diagram", which then connect. The claims land on "…plain files",
// "No AI" and "…nothing to configure".
import { hookScene } from '../hook.js';

const TREE = [
  { d: 0, icon: 'folder', label: 'shop-analytics', open: true },
  { d: 1, icon: 'folder', label: '.erd-studio', open: true },
  { d: 2, icon: 'folder', label: 'gold', open: true },
  { d: 3, icon: 'folder', label: 'diagrams', open: true },
  { d: 4, icon: 'file', label: 'orders.dbml', yml: true },
  { d: 3, icon: 'folder', label: 'tables', open: true },
  { d: 4, icon: 'folder', label: 'gold', open: true },
  { d: 5, icon: 'file', label: 'dim_customer.dbml', fly: 0 },
  { d: 5, icon: 'file', label: 'fct_order.dbml', fly: 1 },
  { d: 5, icon: 'file', label: 'dim_product.dbml', fly: 2 },
  { d: 1, icon: 'file', label: 'README.md', yml: true },
];

const CANVAS = { x: 704, y: 322 };
const NODES = [
  { name: 'dim_customer', x: CANVAS.x + 20, y: CANVAS.y + 92,
    cols: [{ key: 'PK', name: 'customer_key', type: 'INTEGER' }, { name: 'customer_id', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' }] },
  { name: 'fct_order', x: CANVAS.x + 385, y: CANVAS.y + 222,
    cols: [{ key: 'PK', name: 'order_id', type: 'INTEGER' }, { key: 'FK', name: 'customer_key', type: 'INTEGER' }, { key: 'FK', name: 'product_key', type: 'INTEGER' }, { name: 'amount', type: 'DECIMAL' }] },
  { name: 'dim_product', x: CANVAS.x + 750, y: CANVAS.y + 92,
    cols: [{ key: 'PK', name: 'product_key', type: 'INTEGER' }, { name: 'product_name', type: 'VARCHAR' }, { name: 'price', type: 'DECIMAL' }] },
];

export default hookScene({
  tree: TREE, nodes: NODES, tab: 'orders.dbml', crumb: '.erd-studio › gold › diagrams › orders.dbml', beat: 'model',
  // h_model: "Your data model,"(+0.0–0.8) "as a diagram,"(+1.1–1.8) "saved as plain files"(+2.1–3.0)
  // "in your repo."(+3.0–4.0); h_noai: "No AI,"(+0.0–0.75) "and nothing to configure."(+0.95–2.1)
  claims: [['Plain files in Git', 'model', 2.4], ['No AI needed', 'noai', 0.1], ['Nothing to configure', 'noai', 0.95]],
});
