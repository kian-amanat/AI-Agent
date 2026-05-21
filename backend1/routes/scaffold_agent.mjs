// import { runScaffold, runScaffoldFromFile } from "../../scaffold_agent.mjs";
// import path from "path";

// function uuidv4() {
//   return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
//     const r = (Math.random() * 16) | 0;
//     const v = c === "x" ? r : (r & 0x3) | 0x8;
//     return v.toString(16);
//   });
// }

// function formatScaffoldOutput(stats, workspace) {
//   let output = `✅ **Scaffold با موفقیت انجام شد!**\n\n`;
//   output += `📁 **Workspace:** \`${workspace}\`\n\n`;
//   output += `📊 **آمار:**\n`;
//   output += `• تعداد کل فایل‌ها: ${stats.total_files}\n`;
//   output += `• ایجاد شده: ${stats.created_files}\n`;
//   output += `• رد شده (موجود بود): ${stats.skipped_files}\n`;
//   output += `• نامعتبر: ${stats.invalid_files}\n\n`;

//   if (stats.phases && stats.phases.length > 0) {
//     output += `📦 **جزئیات فازها:**\n\n`;
//     stats.phases.forEach((phase) => {
//       output += `**Phase ${phase.phase_order}: ${phase.phase_title}**\n`;
//       phase.steps.forEach((step) => {
//         output += `  • ${step.step_id}: `;
//         output += `${step.files_created} created, `;
//         output += `${step.files_skipped} skipped\n`;
//       });
//       output += `\n`;
//     });
//   }

//   output += `✅ فایل‌ها و فولدرها آماده هستند! می‌تونی شروع به کدنویسی کنی.`;

//   return output;
// }

// export default async function scaffoldAgentRoute(fastify, opts) {
//   // ✅ Route 1: Scaffold از Plan Object
//   fastify.post("/run", async (request, reply) => {
//     try {
//       const { plan, workspace = "./workspace", skipExisting = true } = request.body;

//       if (!plan || typeof plan !== "object") {
//         return reply.code(400).send({
//           ok: false,
//           error: "Missing or invalid 'plan' object",
//         });
//       }

//       if (!plan.phases || !Array.isArray(plan.phases)) {
//         return reply.code(400).send({
//           ok: false,
//           error: "Invalid plan structure: missing phases array",
//         });
//       }

//       console.log("🚀 Running scaffold from plan object...");
//       const stats = await runScaffold(plan, workspace, skipExisting);

//       const formattedContent = formatScaffoldOutput(stats, workspace);

//       return reply.send({
//         ok: true,
//         reply: {
//           id: uuidv4(),
//           role: "assistant",
//           content: formattedContent,
//           createdAt: new Date().toISOString(),
//           metadata: {
//             type: "scaffold",
//             stats: stats,
//             workspace: workspace,
//           },
//         },
//       });
//     } catch (err) {
//       fastify.log.error(err);

//       let errorMessage = "خطا در Scaffold: ";
//       if (err.message.includes("EACCES")) {
//         errorMessage += "دسترسی به فایل سیستم رد شد.";
//       } else if (err.message.includes("ENOENT")) {
//         errorMessage += "مسیر مشخص شده یافت نشد.";
//       } else {
//         errorMessage += err.message;
//       }

//       return reply.code(500).send({
//         ok: false,
//         error: errorMessage,
//       });
//     }
//   });

//   // ✅ Route 2: Scaffold از فایل JSON
//   fastify.post("/run-from-file", async (request, reply) => {
//     try {
//       const { 
//         planFile, 
//         workspace = "./workspace", 
//         skipExisting = true 
//       } = request.body;

//       if (!planFile || typeof planFile !== "string") {
//         return reply.code(400).send({
//           ok: false,
//           error: "Missing or invalid 'planFile' path",
//         });
//       }

//       // تبدیل مسیر نسبی به مطلق
//       const plansDir = path.join(process.cwd(), "plans");
//       const planPath = path.join(plansDir, planFile);

//       console.log("🚀 Running scaffold from file:", planPath);
//       const stats = await runScaffoldFromFile(planPath, workspace, skipExisting);

//       const formattedContent = formatScaffoldOutput(stats, workspace);

//       return reply.send({
//         ok: true,
//         reply: {
//           id: uuidv4(),
//           role: "assistant",
//           content: formattedContent,
//           createdAt: new Date().toISOString(),
//           metadata: {
//             type: "scaffold",
//             stats: stats,
//             workspace: workspace,
//             plan_file: planFile,
//           },
//         },
//       });
//     } catch (err) {
//       fastify.log.error(err);

//       let errorMessage = "خطا در Scaffold: ";
//       if (err.message.includes("Plan file not found")) {
//         errorMessage += "فایل JSON پیدا نشد.";
//       } else if (err.message.includes("EACCES")) {
//         errorMessage += "دسترسی به فایل سیستم رد شد.";
//       } else {
//         errorMessage += err.message;
//       }

//       return reply.code(500).send({
//         ok: false,
//         error: errorMessage,
//       });
//     }
//   });
// }
