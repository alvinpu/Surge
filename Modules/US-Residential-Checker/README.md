# US Residential Checker

Surge Mac 独立模块，定期将美国住宅／家宽出口写入已有的 `Static Residential` 智能策略组。适合希望把家宽线路单独分组的用户。[安装模块](https://raw.githubusercontent.com/alvinpu/Surge/refs/heads/main/Modules/US-Residential-Checker/US-Residential-Checker.sgmodule)

## 安装和使用

1. 在 Surge Mac 的可编辑配置中，准备一个名为 `Static Residential` 或 `🏠Static Residential 🇺🇸` 的专用 smart 组。已有组可以直接沿用。新建时可把下面这行放进 `[Proxy Group]`，将“节点订阅”换成实际订阅组名。
   
   ```ini
   Static Residential = smart, include-other-group="节点订阅", evaluate-before-use=1
   ```

2. 打开脚本功能，在模块页面从 URL 安装并启用本页顶部的模块。首次可在脚本页运行 `US Residential Scan`，然后核对策略组成员。
3. 每天按 Mac 当地时间 06:00 扫描，06:20 补位。共用 iCloud 配置的 Mac 根据共享记录跳过同轮检测；同步延迟时可能重复启动。iPhone 可以使用同步后的策略组。手动重测请点 **Surge 菜单栏 → 面板 → Static Residential → 刷新按钮**。

## 住宅线路的判断

从本地代理和全部已加载订阅中，按 🇺🇸、美国、美國、US、USA、United States 等名称标记找候选。每条策略都绑定自身出口查询一次 IPPure。美国且住宅字段明确为真时，再从同一策略向 proxycheck 查询刚才观测到的那个 IP。只有两家都返回美国、且第二家用途为 `Residential` 才入组。各请求限时 15 秒。不同线路即使共用出口也可分别入组。[IPPure 字段说明](https://ippure.com/MyIP-Info-API) · [proxycheck 用途分类](https://proxycheck.io/api/?cr=1)

该分组只依据住宅属性，不要求 AI 解锁、风险分或测速结果。组名中的 Static 沿用 Surge 配置命名；一次出口分类无法证明运营商分配了固定 IP。查询超时、分类缺失或两家结论冲突的线路留在本次报告中。整轮零条通过时保留现有组，面板会提示。首次使用应等到面板显示已成功写回，再将需要家宽的流量指向该组。
