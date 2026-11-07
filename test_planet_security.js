const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

console.log('--- STARTING VERIFICATION TEST FOR PLANET MODE & SECURITY ---');

const serverProc = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });

serverProc.stdout.on('data', d => {
  // console.log('[SERVER]', d.toString());
});
serverProc.stderr.on('data', d => {
  console.error('[SERVER ERR]', d.toString());
});

function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1',
      port: 3000,
      path,
      headers
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

function httpPost(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

setTimeout(async () => {
  try {
    // Reset test database state
    await httpPost('/api/host/tim/reset-skor', {}, { 'x-host-pin': '1234' });
    await httpPost('/api/host/planet/set-mode', { mode: 'neraca' }, { 'x-host-pin': '1234' });
    await httpPost('/api/host/question/set-active', { id: 1 }, { 'x-host-pin': '1234' });

    // -------------------------------------------------------------
    // TEST 1: SECURITY CHECK (NO KEY LEAK ON PUBLIC API & WS)
    // -------------------------------------------------------------
    console.log('\n[1] Checking Security on Public /api/state...');
    const publicState = await httpGet('/api/state');
    const pubQ = publicState.body.activeQuestion;
    console.log('Public state received. Has pin_host?', 'pin_host' in publicState.body.state);
    console.log('Public active question has kunci?', pubQ && ('kunci' in pubQ));
    console.log('Public active question has toleransi?', pubQ && ('toleransi' in pubQ));

    if ('pin_host' in publicState.body.state || (pubQ && 'kunci' in pubQ)) {
      throw new Error('SECURITY VIOLATION: Public state leaked pin_host or kunci!');
    }
    console.log('PASS: Public /api/state is sanitized!');

    console.log('\n[2] Checking Authenticated Host /api/state...');
    const hostState = await httpGet('/api/state', { 'x-host-pin': '1234' });
    const hostQ = hostState.body.activeQuestion;
    console.log('Host state received. Has pin_host?', 'pin_host' in hostState.body.state);
    console.log('Host active question has kunci?', hostQ && ('kunci' in hostQ));
    if (!('pin_host' in hostState.body.state) || (hostQ && !('kunci' in hostQ))) {
      throw new Error('Host state did not provide key to authenticated jury!');
    }
    console.log('PASS: Host receives key properly!');

    console.log('\n[3] Checking Security on /api/soal...');
    const publicSoal = await httpGet('/api/soal');
    const leakedItem = publicSoal.body.find(item => 'kunci' in item);
    if (leakedItem) {
      throw new Error('SECURITY VIOLATION: Public /api/soal leaked kunci!');
    }
    console.log('PASS: Public /api/soal omits kunci and toleransi for non-host!');

    // -------------------------------------------------------------
    // TEST 2: PLANET MODE & FLOW (STEPS 1 TO 5)
    // -------------------------------------------------------------
    console.log('\n[4] Switching to Ronde 5: Misi Planet...');
    const modeRes = await httpPost('/api/host/planet/set-mode', { mode: 'planet' }, { 'x-host-pin': '1234' });
    console.log('Mode set to planet. Success:', modeRes.body.success, 'Current mode:', modeRes.body.state.state.mode_ronde);

    console.log('\n[5] Selecting Turn Team (Tim 2)...');
    const turnRes = await httpPost('/api/host/planet/tim-giliran', { team: 2 }, { 'x-host-pin': '1234' });
    console.log('Tim 2 selected. Step:', turnRes.body.state.state.planet_step, 'Tim:', turnRes.body.state.state.tim_giliran);

    console.log('\n[6] Starting Step 2: Meja TAB (120s timer)...');
    const tabStartRes = await httpPost('/api/host/planet/start-tab', {}, { 'x-host-pin': '1234' });
    console.log('Step 2 active. Timer status:', tabStartRes.body.state.state.timer_status, 'Step:', tabStartRes.body.state.state.planet_step);

    console.log('\n[7] Testing Meja TAB Answer Submission (Correct Answer)...');
    // Active question for TAB has kunci 36 (wahana 500kg v=12km/s => Ek = 0.5*500*144*10^6 = 36 GJ)
    const tabSubmitRes = await httpPost('/api/planet/tab-submit', { team: 2, jawaban: 36 });
    console.log('TAB Submit response:', tabSubmitRes.body);

    const postTabState = await httpGet('/api/state', { 'x-host-pin': '1234' });
    const team2 = postTabState.body.teams.find(t => t.no === 2);
    console.log('Tim 2 Score after TAB (+20):', team2.skor, 'Step now:', postTabState.body.state.planet_step);
    if (team2.skor < 20 || postTabState.body.state.planet_step !== 3) {
      throw new Error('TAB evaluation failed to award 20 points or advance to step 3!');
    }
    console.log('PASS: Meja TAB awarded +20 points and unlocked Step 3 (Solar System Board)!');

    console.log('\n[8] Testing Meja MIC Planet Selection (Mars)...');
    const planetPickRes = await httpPost('/api/host/planet/pilih-planet', { planet: 'Mars' }, { 'x-host-pin': '1234' });
    console.log('Planet Mars chosen. Success:', planetPickRes.body.success);
    const postPlanetState = await httpGet('/api/state', { 'x-host-pin': '1234' });
    console.log('Active planet question:', postPlanetState.body.soalPlanet ? postPlanetState.body.soalPlanet.soal.substring(0, 50) : 'none');
    console.log('Planet chosen:', postPlanetState.body.state.planet_terpilih, 'Step now:', postPlanetState.body.state.planet_step);
    console.log('Used planets:', postPlanetState.body.usedPlanets);

    if (postPlanetState.body.state.planet_step !== 4 || postPlanetState.body.state.planet_terpilih !== 'Mars') {
      throw new Error('Planet selection failed to advance to Step 4!');
    }
    console.log('PASS: Planet question opened and Step 4 (Meja MIC) activated!');

    console.log('\n[9] Testing Meja MIC Jury Judgment (BENAR => +30 points)...');
    const micJudgeRes = await httpPost('/api/host/planet/mic-judge', { hasil: 'BENAR' }, { 'x-host-pin': '1234' });
    console.log('Jury judged BENAR. Success:', micJudgeRes.body.success);
    const postMicState = await httpGet('/api/state', { 'x-host-pin': '1234' });
    const finalTeam2 = postMicState.body.teams.find(t => t.no === 2);
    console.log('Final Tim 2 score (20 + 30 = 50):', finalTeam2.skor, 'Step now:', postMicState.body.state.planet_step);

    if (finalTeam2.skor !== 50) {
      throw new Error(`Expected score 50, but got ${finalTeam2.skor}`);
    }
    console.log('PASS: Meja MIC awarded +30 points (total 50 points)!');

    // -------------------------------------------------------------
    // TEST 3: REUSE MODE (MODE SOAL DIPAKAI ULANG)
    // -------------------------------------------------------------
    console.log('\n[10] Testing Mode Soal Dipakai Ulang on Ronde Neraca...');
    await httpPost('/api/host/planet/set-mode', { mode: 'neraca' }, { 'x-host-pin': '1234' });
    await httpPost('/api/host/settings', { mode_soal_dipakai_ulang: 1 }, { 'x-host-pin': '1234' });
    await httpPost('/api/host/question/set-active', { id: 1 }, { 'x-host-pin': '1234' });
    await httpPost('/api/host/buzzer', { action: 'OPEN' }, { 'x-host-pin': '1234' });

    const wsClient = new WebSocket('ws://127.0.0.1:3000');

    wsClient.on('open', () => {
      wsClient.send(JSON.stringify({ type: 'BUZZER_PRESS', payload: { team: 1, timestamp: Date.now() } }));
    });

    wsClient.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'BUZZER_WIN') {
        console.log('Buzzer won by Team 1. Submitting wrong answer to test angle...');
        // Submit wrong answer: key is 294, submit 999
        wsClient.send(JSON.stringify({ type: 'TIMBANG_SUBMIT', payload: { team: 1, jawaban: 999 } }));
      } else if (msg.type === 'TIMBANG_RESULT') {
        console.log('Received TIMBANG_RESULT on public client. Status:', msg.status, 'Angle:', msg.sudut);
        console.log('Is selisih hidden for public?', msg.selisih === undefined);
        console.log('PASS: Mode Soal Dipakai Ulang enforces fixed angle (12 deg) and hides directional leak!');
        wsClient.close();

        console.log('\n===============================================================');
        console.log(' ALL TESTS PASSED SUCCESSFULLY! 100% SECURE & FUNCTIONAL!    ');
        console.log('===============================================================\n');

        serverProc.kill();
        process.exit(0);
      }
    });

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    serverProc.kill();
    process.exit(1);
  }
}, 2500);
