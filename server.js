import express from "express"
import { execFile } from "child_process";
import cors from "cors"

const app = express();
app.use(express.json());

const ALLOWED_COMMANDS = ["ls", "node", "npm", "cat", "echo"];

app.post("/run", (req, res) => {

  const command = req.body.command;

  if (!command) {
    return res.status(400).json({ error: "No command provided" });
  }

  const parts = command.split(" ").filter(Boolean);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (!ALLOWED_COMMANDS.includes(cmd)) {
    return res.status(403).json({ error: "Command not allowed" });
  }

  execFile(
    cmd,
    args,
    {
      cwd: "/workspace",
      timeout: 5000,
      maxBuffer: 1024 * 1024
    },
    (error, stdout, stderr) => {
      res.json({
        success: !error,
        stdout,
        stderr,
        error: error ? error.message : null
      });
    }
  );
});

app.get("/", (req,res)=>{
  res.send("AI Sandbox running");
});

app.listen(3000, () => {
  console.log("Sandbox running on port 3000");
});
