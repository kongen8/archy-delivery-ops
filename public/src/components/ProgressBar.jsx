function ProgressBar({done,total,color="#1e293b"}){
  const pct=total>0?(done/total*100):0;
  return <div style={{background:'#e2e8f0',borderRadius:4,height:6,overflow:'hidden'}}>
    <div className="progress-bar" style={{width:`${pct}%`,background:color,height:'100%',borderRadius:4}}/>
  </div>;
}
