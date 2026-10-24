    // 文字识别/重建的字体清单：苹方等系统字体版权不可商用，默认与首选都用
    // 可免费商用的阿里巴巴普惠体 3.0 与思源黑体（PostScript 名与 Photoshop
    // textItem.font 对齐，且需本机安装对应字体）。
    const TEXT_REBUILD_FONTS = [
      { group: '阿里巴巴普惠体 3.0（免费商用）', items: [
        { ps: 'AlibabaPuHuiTi_3_35_Thin', label: '普惠体 35 Thin 细体' },
        { ps: 'AlibabaPuHuiTi_3_45_Light', label: '普惠体 45 Light 纤细' },
        { ps: 'AlibabaPuHuiTi_3_55_Regular', label: '普惠体 55 Regular 常规' },
        { ps: 'AlibabaPuHuiTi_3_65_Medium', label: '普惠体 65 Medium 中黑' },
        { ps: 'AlibabaPuHuiTi_3_85_Bold', label: '普惠体 85 Bold 粗体' },
        { ps: 'AlibabaPuHuiTi_3_95_ExtraBold', label: '普惠体 95 ExtraBold 特粗' },
        { ps: 'AlibabaPuHuiTi_3_105_Heavy', label: '普惠体 105 Heavy 重磅' },
        { ps: 'AlibabaPuHuiTi_3_115_Black', label: '普惠体 115 Black 玄黑' }
      ] },
      { group: '思源黑体（免费商用）', items: [
        { ps: 'SourceHanSansSC-ExtraLight', label: '思源黑体 ExtraLight 极细' },
        { ps: 'SourceHanSansSC-Light', label: '思源黑体 Light 细体' },
        { ps: 'SourceHanSansSC-Normal', label: '思源黑体 Normal' },
        { ps: 'SourceHanSansSC-Regular', label: '思源黑体 Regular 常规' },
        { ps: 'SourceHanSansSC-Medium', label: '思源黑体 Medium 中黑' },
        { ps: 'SourceHanSansSC-Bold', label: '思源黑体 Bold 粗体' },
        { ps: 'SourceHanSansSC-Heavy', label: '思源黑体 Heavy 重磅' }
      ] },
      { group: '思源宋体（需安装对应字体）', items: [
        { ps: 'SourceHanSerifSC-Regular', label: '思源宋体 Regular 常规' },
        { ps: 'SourceHanSerifSC-Bold', label: '思源宋体 Bold 粗体' },
        { ps: 'SourceHanSerifSC-Heavy', label: '思源宋体 Heavy 重磅' }
      ] },
      { group: 'Inter（免费商用·现代无衬线）', items: [
        { ps: 'Inter-Thin', label: 'Inter Thin' },
        { ps: 'Inter-ExtraLight', label: 'Inter ExtraLight' },
        { ps: 'Inter-Light', label: 'Inter Light' },
        { ps: 'Inter-Regular', label: 'Inter Regular' },
        { ps: 'Inter-Medium', label: 'Inter Medium' },
        { ps: 'Inter-SemiBold', label: 'Inter SemiBold' },
        { ps: 'Inter-Bold', label: 'Inter Bold' },
        { ps: 'Inter-ExtraBold', label: 'Inter ExtraBold' },
        { ps: 'Inter-Black', label: 'Inter Black' }
      ] },
      { group: 'Montserrat（免费商用·几何无衬线）', items: [
        { ps: 'Montserrat-Thin', label: 'Montserrat Thin' },
        { ps: 'Montserrat-ExtraLight', label: 'Montserrat ExtraLight' },
        { ps: 'Montserrat-Light', label: 'Montserrat Light' },
        { ps: 'Montserrat-Regular', label: 'Montserrat Regular' },
        { ps: 'Montserrat-Medium', label: 'Montserrat Medium' },
        { ps: 'Montserrat-SemiBold', label: 'Montserrat SemiBold' },
        { ps: 'Montserrat-Bold', label: 'Montserrat Bold' },
        { ps: 'Montserrat-ExtraBold', label: 'Montserrat ExtraBold' },
        { ps: 'Montserrat-Black', label: 'Montserrat Black' }
      ] },
      { group: 'Poppins（免费商用·圆润几何）', items: [
        { ps: 'Poppins-Thin', label: 'Poppins Thin' },
        { ps: 'Poppins-ExtraLight', label: 'Poppins ExtraLight' },
        { ps: 'Poppins-Light', label: 'Poppins Light' },
        { ps: 'Poppins-Regular', label: 'Poppins Regular' },
        { ps: 'Poppins-Medium', label: 'Poppins Medium' },
        { ps: 'Poppins-SemiBold', label: 'Poppins SemiBold' },
        { ps: 'Poppins-Bold', label: 'Poppins Bold' },
        { ps: 'Poppins-ExtraBold', label: 'Poppins ExtraBold' },
        { ps: 'Poppins-Black', label: 'Poppins Black' }
      ] },
      { group: 'Source Sans Pro（免费商用·人文无衬线）', items: [
        { ps: 'SourceSansPro-ExtraLight', label: 'Source Sans Pro ExtraLight' },
        { ps: 'SourceSansPro-Light', label: 'Source Sans Pro Light' },
        { ps: 'SourceSansPro-Regular', label: 'Source Sans Pro Regular' },
        { ps: 'SourceSansPro-Semibold', label: 'Source Sans Pro Semibold' },
        { ps: 'SourceSansPro-Bold', label: 'Source Sans Pro Bold' },
        { ps: 'SourceSansPro-Black', label: 'Source Sans Pro Black' }
      ] },
      { group: '西文/系统（注意授权）', items: [
        { ps: 'ArialMT', label: 'Arial' },
        { ps: 'Arial-BoldMT', label: 'Arial Bold' },
        { ps: 'HelveticaNeue', label: 'Helvetica Neue' },
        { ps: 'SongtiSC-Regular', label: '宋体（macOS 系统字体，慎商用）' }
      ] }
    ];
    const TEXT_REBUILD_DEFAULT_FONT = 'AlibabaPuHuiTi_3_55_Regular';
    function textRebuildFontValue(item) {
      const current = item && (item.fontPostScript || item.fontFamily) || '';
      return TEXT_REBUILD_FONTS.some((group) => group.items.some((font) => font.ps === current))
        ? current
        : TEXT_REBUILD_DEFAULT_FONT;
    }
