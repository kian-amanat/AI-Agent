import { getUsers } from "./apiClient.mjs";

export async function renderUserList() {
  const users = await getUsers();
  return users.map((u) => u.name).join(", ");
}

export async function renderUser(id) {
  // TODO: fetch and render a single user by id
  return "";
}
