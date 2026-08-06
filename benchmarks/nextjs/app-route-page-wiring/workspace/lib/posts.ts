export type Post = {
  slug: string;
  title: string;
};

const POSTS: Post[] = [
  { slug: "hello-world", title: "Hello World" },
  { slug: "app-router", title: "Understanding the App Router" },
  { slug: "server-components", title: "Server Components in Practice" },
];

export function getPosts(): Post[] {
  return POSTS;
}
