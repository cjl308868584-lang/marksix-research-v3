# 六合智研

香港与新澳门开奖、近30期条件规律和五项逐期学习。

- 开奖首页：实时数据、历史记录、开奖动效及本地分析。
- `/patterns`：开奖前冻结的近30期条件 A → 下一期结果 B、五项参考及逐期复盘。
- `/learning`：单肖、单尾、二连肖、三连肖、特码号码的五项前瞻学习账本。
- 开奖后先结算，再重扫近30期并冻结下一期；不回填已经开奖的预测。
- 等待核验属于可重试状态，不保存为永久完成任务。

旧四项高概率策略中心及其复盘、专属接口、训练与数据表已移除。规律与五项学习使用独立后台流程。

## 运行与验证

```sh
npm install
npm run dev
npm test
```

刷新本地开奖快照：`npm run data:sync`。
AI 文本分析使用 `.env.example` 中的服务端配置。没有密钥仍可使用统计功能。

## 自动更新

GitHub Actions 在北京时间 21:40–22:30 每五分钟检查，并每两小时补查。
配置仓库 secrets：`RESEARCH_SITE_URL`、`RESEARCH_INGEST_SECRET`。

```sh
PYTHONPATH=research/src python3 -m marksix_research.cli cycle --site-url SITE --secret SECRET --game new_macau --output-dir research-artifacts/new_macau
PYTHONPATH=research/src python3 -m marksix_research.cli health-check --site-url SITE --game new_macau
```

写入入口：`POST /api/internal/patterns/settle-and-freeze` 与 `POST /api/internal/learning/settle-and-freeze`。
二者要求五分钟内的 HMAC-SHA256 签名；公开读取接口不会触发训练或写库。
后台与公开开奖使用同一个最新核验数据源，历史扫描仍使用最多500期；未来数据与已核验冲突会被拒绝。

读取入口：`/api/research/patterns`、`/api/research/patterns/reviews`、`/api/learning/forecast`、`/api/learning/reviews`、`/api/learning/performance`。

本项目提供第三方历史数据研究，不销售彩票、不接受投注、不承诺收益。
