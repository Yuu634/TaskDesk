'use strict';
// Only historical context is abbreviated. The current instructions and criteria
// are retained verbatim, and the actual transport encoder decides what fits.
function fitPreviousResults(previous, build, validate) {
  const full = build(previous);
  function fits(prompt) {
    try { validate(prompt); return true; }
    catch (e) { if (/大きすぎ|24000/.test(e.message)) return false; throw e; }
  }
  if (fits(full)) return { prompt:full, abbreviated:false };
  const notice = '\n\n先行タスクの結果は起動時の長さ制限に合わせた末尾の抜粋です。省略を含むため、必要な根拠・仕様は記載された成果物で確認してください。';
  let records = previous.map(p=>({...p,result:Array.from(p.result || '')}));
  const render = limit => build(records.map(p=>({...p,result:p.result.length > limit ? '（前半省略）\n'+p.result.slice(-limit || p.result.length).join('') : p.result.join('')})))+notice;
  // Preserve at least a useful tail for each retained result. Prefer recent
  // results if even the titles and short tails cannot all fit.
  while (records.length && !fits(render(128))) records.shift();
  if (!records.length) {
    const prompt=build([])+notice;validate(prompt);return {prompt,abbreviated:true};
  }
  let low=128,high=Math.max(128,...records.map(p=>p.result.length));
  while(low<high){const mid=Math.ceil((low+high)/2);if(fits(render(mid)))low=mid;else high=mid-1;}
  const prompt=render(low);validate(prompt);return {prompt,abbreviated:true};
}
module.exports={fitPreviousResults};
