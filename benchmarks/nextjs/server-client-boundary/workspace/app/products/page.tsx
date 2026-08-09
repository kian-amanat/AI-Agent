import { useState } from "react";
import { getProducts } from "../../lib/db";

// BROKEN: a Server Component using client hooks, mis-awaited params, and a
// server-only import reachable from client code.
export default async function ProductsPage({ params }: { params: { category: string } }) {
  const products = await getProducts(params.category);
  const [cart, setCart] = useState<string[]>([]);

  return (
    <main>
      <h1>{params.category}</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.title} — {p.price}
            <button onClick={() => setCart([...cart, p.id])}>Add to cart</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
