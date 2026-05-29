// pipeline_agent.mjs - با Real-time Logging
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ پشتیبانی از هر دو روش: command line و environment variable
const userMessage = process.env.USER_MESSAGE || process.argv.slice(2).join(' ');

if (!userMessage) {
  console.error('Usage: node pipeline_agent.mjs <your request>');
  console.error('   or: USER_MESSAGE="your request" node pipeline_agent.mjs');
  process.exit(1);
}

console.log('🚀 Starting Pipeline...\n');
console.log(`📝 Request: "${userMessage}"\n`);
console.log('='.repeat(60) + '\n');

/**
 * اجرای یک agent با real-time logging
 */
async function runAgent(agentName, scriptPath, input) {
  return new Promise((resolve, reject) => {
    console.log(`\n${'▶'.repeat(3)} Running ${agentName}...`);
    console.log(`   Script: ${path.basename(scriptPath)}`);
    console.log(`   Input: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`);
    console.log('-'.repeat(60));
    
    const startTime = Date.now();
    
    // ✅ استفاده از spawn برای real-time output
    const child = spawn('node', [scriptPath, input], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin ignore, stdout/stderr pipe
      env: { ...process.env, FORCE_COLOR: '1' } // حفظ رنگ‌ها
    });

    let hasOutput = false;

    // ✅ نمایش real-time stdout
    child.stdout.on('data', (data) => {
      hasOutput = true;
      process.stdout.write(data); // نمایش مستقیم بدون buffer
    });

    // ✅ نمایش real-time stderr
    child.stderr.on('data', (data) => {
      hasOutput = true;
      process.stderr.write(data); // نمایش مستقیم خطاها
    });

    // ✅ مدیریت خروج process
    child.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('-'.repeat(60));
      
      if (code === 0) {
        console.log(`✅ ${agentName} completed successfully (${elapsed}s)\n`);
        resolve();
      } else {
        console.error(`❌ ${agentName} failed with exit code ${code} (${elapsed}s)\n`);
        reject(new Error(`${agentName} exited with code ${code}`));
      }
    });

    // ✅ مدیریت خطاهای spawn
    child.on('error', (error) => {
      console.error(`❌ ${agentName} spawn error:`, error.message);
      reject(error);
    });

    // ✅ Timeout protection (2 minutes per agent)
    const timeout = setTimeout(() => {
      console.error(`⏱️  ${agentName} timeout - killing process...`);
      child.kill('SIGTERM');
      
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
      
      reject(new Error(`${agentName} timed out after 2 minutes`));
    }, 120000);

    child.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * اجرای کامل pipeline
 */
async function runPipeline() {
  const pipelineStart = Date.now();
  
  try {
    // 1️⃣ Planner
    console.log('\n' + '='.repeat(60));
    console.log('📋 PHASE 1/5: PLANNING');
    console.log('='.repeat(60));
    await runAgent('Planner', path.join(__dirname, 'planner_agent.mjs'), userMessage);
    
    // 2️⃣ Scaffold
    console.log('\n' + '='.repeat(60));
    console.log('🏗️  PHASE 2/5: SCAFFOLDING');
    console.log('='.repeat(60));
    await runAgent('Scaffold', path.join(__dirname, 'scaffold_agent.mjs'), userMessage);
    
    // 3️⃣ Codegen
    console.log('\n' + '='.repeat(60));
    console.log('💻 PHASE 3/5: CODE GENERATION');
    console.log('='.repeat(60));
    await runAgent('Codegen', path.join(__dirname, 'codegen_agent.mjs'), userMessage);
    
    // 4️⃣ Test
    // console.log('\n' + '='.repeat(60));
    // console.log('🧪 PHASE 4/5: TESTING');
    // console.log('='.repeat(60));
    // await runAgent('Test', path.join(__dirname, 'test_agent.mjs'), userMessage);
    
    // 5️⃣ Fixer
    // console.log('\n' + '='.repeat(60));
    // console.log('🔧 PHASE 5/5: FIXING');
    // console.log('='.repeat(60));
    // await runAgent('Fixer', path.join(__dirname, 'fixer_agent.mjs'), userMessage);
    
    // ✅ Final Summary
    const totalTime = ((Date.now() - pipelineStart) / 1000).toFixed(2);
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 PIPELINE COMPLETED SUCCESSFULLY');
    console.log('='.repeat(60));
    console.log(`⏱️  Total time: ${totalTime}s`);
    console.log(`📝 Request: "${userMessage}"`);
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    const totalTime = ((Date.now() - pipelineStart) / 1000).toFixed(2);
    
    console.error('\n' + '='.repeat(60));
    console.error('❌ PIPELINE FAILED');
    console.error('='.repeat(60));
    console.error(`⏱️  Failed after: ${totalTime}s`);
    console.error(`💥 Error: ${error.message}`);
    console.error('='.repeat(60) + '\n');
    
    process.exit(1);
  }
}

runPipeline();
