import http from "http";
import app from "./app.js";
import { initUserModel } from "./models/user.model.js";
import { initTokenModel } from "./models/token.model.js";

initUserModel();
initTokenModel();

const PORT = process.env.PORT || 4000;

let serverInstance = null;

if (process.env.NODE_ENV !== "test") {
  serverInstance = http.createServer(app);
  serverInstance.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

export default app;
export { serverInstance };
