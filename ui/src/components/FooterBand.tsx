import { OctocatIc } from "../icons";

export function FooterBand() {
  return (
    <footer>
      <div className="inner">
        <div className="mark" style={{ marginTop: 5 }}><i></i><i></i><i></i><i></i></div>
        <div className="txt">
          <b>HX UI runs locally, as part of the <code className="hx">hx</code> client.</b><br />
          This page is served from this machine and never sends your data anywhere.
        </div>
        <div className="oss">
          <div className="osslbl">Open source</div>
          <a href="https://github.com/let-ai-oss/hx"><OctocatIc /> github.com/let-ai-oss/hx</a>
          <a href="https://hxframework.org">About the HX framework</a>
        </div>
      </div>
    </footer>
  );
}
