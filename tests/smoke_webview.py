import json
import threading
from pathlib import Path

import webview

from main import SerialApi


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    window = webview.create_window(
        "Serial UI - smoke test",
        str(ROOT / "GUI" / "index.html"),
        js_api=SerialApi(),
        width=1280,
        height=800,
        hidden=True,
    )

    def inspect() -> None:
        result = window.evaluate_js(
            "document.querySelector('#add-filter').click(); JSON.stringify({"
            "views: document.querySelectorAll('.view').length,"
            "title: document.title,"
            "brand: document.querySelector('.brand-lockup b').textContent,"
            "active: document.querySelector('.view.active').id,"
            "nav: document.querySelectorAll('.nav-item').length,"
            "port: document.querySelector('#serial-port').value,"
            "connectionPanes: document.querySelectorAll('.connection-pane.active').length,"
            "raw: document.querySelector('#raw').checked,"
            "optionTabs: document.querySelectorAll('.option-tab').length,"
            "activeOption: document.querySelector('.option-pane.active').id,"
            "filterOperations: document.querySelectorAll('.filter-operation option').length,"
            "filterComparisons: document.querySelectorAll('.filter-compare option').length,"
            "numpadChoices: document.querySelectorAll('.button-key option').length,"
            "structuredColors: [[{type:'date_dmy'},'13/07/2026'],[{type:'date_ymd'},'2026/07/13'],[{type:'time_hms'},'12:34:56'],[{type:'mark_time'},'1234:00,000'],[{type:'braces'},'{data}']].every(([rule,sample]) => new RegExp(colorRulePattern(rule)).test(sample)),"
            "optionFits: ['buttons','colors','filters'].reduce((fits,name) => { showOptionPane(name); const pane=document.querySelector('#option-'+name); fits[name]=pane.scrollHeight <= pane.clientHeight; return fits; }, {}),"
            "logModal: Boolean(document.querySelector('#log-modal'))," 
            "fileModal: Boolean(document.querySelector('#file-modal'))," 
            "shortcuts: document.querySelectorAll('.shortcut-row').length," 
            "transport: [document.querySelector('#text-encoding').value,document.querySelector('#line-ending').value]," 
            "signals: document.querySelectorAll('.signal-input').length," 
            "connectionLocks: (() => { setConnectionState(true); const locked = document.querySelector('#use-physical').disabled && document.querySelector('#serial-port').disabled && document.querySelector('#connect-btn').disabled; setConnectionState(false); return locked; })(),"
            "resizeHandles: document.querySelectorAll('.resize-handle').length,"
            "mainFits: document.querySelector('main').scrollHeight <= document.querySelector('main').clientHeight,"
            "viewFits: ['overview','options','config','settings'].reduce((fits,name) => { showView(name); const view=document.querySelector('#view-'+name); fits[name]=view.scrollHeight <= view.clientHeight; return fits; }, {}),"
            "language: document.querySelector('#pause-rx').textContent,"
            "theme: getComputedStyle(document.documentElement).getPropertyValue('--orange').trim()"
            "})"
        )
        state = json.loads(result)
        assert state["views"] == 4
        assert state["title"] == "PortWaver Serial Terminal"
        assert state["brand"] == "PORTWAVER"
        assert state["nav"] == 4
        assert state["active"] == "view-config"
        assert state["connectionPanes"] == 1
        assert state["raw"] is True
        assert state["optionTabs"] == 3
        assert state["activeOption"] == "option-buttons"
        assert state["filterOperations"] >= 7
        assert state["filterComparisons"] >= 12
        assert state["numpadChoices"] >= 17
        assert state["structuredColors"] is True
        assert all(state["optionFits"].values())
        assert state["logModal"] is True
        assert state["fileModal"] is True
        assert state["shortcuts"] == 12
        assert state["transport"] == ["utf-8", "lf"]
        assert state["signals"] == 4
        assert state["connectionLocks"] is True
        assert state["resizeHandles"] == 8
        assert state["mainFits"] is True
        assert all(state["viewFits"].values())
        assert state["language"] == "PAUSE"
        assert state["theme"] == "#ed5b20"
        print(json.dumps(state))
        window.destroy()

    window.events.loaded += lambda: threading.Timer(1, inspect).start()
    webview.start()


if __name__ == "__main__":
    main()
