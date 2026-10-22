# Region presets

Verified on 2026-10-22 against official object-storage documentation:

- [AWS S3 regions and endpoints](https://docs.aws.amazon.com/general/latest/gr/s3.html)
- [Huawei OBS regions and endpoints](https://support.huaweicloud.com/usermanual-obs/obs_41_0003.html)
- [Tencent COS regions](https://cloud.tencent.com/document/product/436/6224)
- [Alibaba OSS regions and endpoints](https://www.alibabacloud.com/help/en/oss/user-guide/regions-and-endpoints)

The offline selector contains public-region presets, not an exhaustive live inventory or a guarantee of account access. Select “自定义区域…” for private, financial, sovereign or newly available regions absent from the list. Existing custom region values are preserved when editing. S3-compatible services use their own configured signing region.

Each entry includes its Chinese name and exact provider-specific region ID. Region IDs are not interchangeable across providers: Singapore is `ap-southeast-1` for AWS/OSS, `ap-southeast-3` for OBS, and `ap-singapore` for COS.
