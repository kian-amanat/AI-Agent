const express = require("express");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

app.post("/run", (req, res) => {

  const command = req.body.command;

  if (!command) {
    return res.status(400).json({ error: "No command provided" });
  }

  exec(command, { cwd: "/workspace" }, (error, stdout, stderr) => {

    res.json({
      success: !error,
      stdout,
      stderr
    });

  });

});

app.get("/", (req,res)=>{
  res.send("AI Sandbox running");
})

app.listen(3000, () => {
  console.log("Sandbox running on port 3000");
});
