# 前端组件约定

基础交互优先使用成熟组件库。当前使用 **Radix UI Primitives** 和 **Lucide React**，在 `PluHub-Plugins/lib/ui/` 中保留兼容现有插件调用的薄封装。

| 元件 | 实现 | 本项目负责 |
| --- | --- | --- |
| 下拉选择 | `@radix-ui/react-select` | 将现有 option/optgroup、原始表单值和原生校验接入组件，复用站点颜色与密度 |
| 弹窗 | `@radix-ui/react-dialog` | 业务标题、关闭条件、操作按钮和现有布局 |
| 图标 | `lucide-react` 的具名导出 | 将现有语义名称映射到标准图标，按需打包 |

键盘导航、选项定位、碰撞避让、焦点约束与弹窗层级交给组件库处理，不再另写一套通用交互。原生多选与列表选择保留浏览器控件；单选通过兼容封装保持现有 `FormData`、required、受控/非受控及 reset 行为。

新增基础控件优先查找现有封装和 Radix 对应组件，新增图标从 Lucide 选择；业务专属的渠道流程、用量图表等仍按功能处理，不能用通用控件迁移冒充已完成专用图表库改造。需要复杂表格或流程编辑时，应先评估成熟表格、图表与流程组件。

紧凑密度、品牌配色与明暗主题仍使用 Console 的 CSS 变量。避免在不同页面并行引入多套具有冲突全局样式的 UI 框架。依赖固定版本并提交 lockfile；公共 UI SDK 不暴露组件库内部对象或要求第三方插件导入官方插件私有源码。

本地浏览器验收应覆盖表单值、空选项、分组禁用、重置、动态选项、弹窗内选择、嵌套确认、忙碌时关闭限制、Escape、焦点恢复及手机/深色模式。只读线上验收不执行付款、调账或其他业务写操作。

参考：[Radix UI Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction)、[Lucide](https://lucide.dev/guide/packages/lucide-react)。
