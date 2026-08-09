import "server-only";

export type Product = { id: string; title: string; price: number };

export async function getProducts(category: string): Promise<Product[]> {
  return [
    { id: "p1", title: "Desk", price: 199 },
    { id: "p2", title: "Chair", price: 89 },
  ].filter(() => Boolean(category));
}
