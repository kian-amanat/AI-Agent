import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>
    </main>
  );
}
