import json,sys,tempfile,subprocess,xml.etree.ElementTree as ET,base64,io
from pathlib import Path
from PIL import Image
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='dsh-svg-') as td:
    p=Path(td)
    source=p/'原图 空格.png'; clean=p/'清理底图.png'; output=p/'文字.svg'
    Image.new('RGB',(400,200),'red').save(source)
    Image.new('RGB',(400,200),'white').save(clean)
    row=dict(text='可编辑文字',fontPostScript='AlibabaPuHuiTi_3_95_ExtraBold',fontSize=64,color='#123456',tracking=25,textAlign='center',geometry=dict(fontSize=64,align='center',transform=[1,0,0,1,120.5,87.25]))
    spec=dict(input=str(source),output=str(output),clean_input=str(clean),blocks=json.dumps([row],ensure_ascii=False),result_output=str(p/'返回结果.json'))
    (p/'spec.json').write_text(json.dumps(spec,ensure_ascii=False),encoding='utf-8')
    r=subprocess.run([sys.executable,str(root/'scripts/export_text_svg.py'),'--spec',str(p/'spec.json')],capture_output=True,text=True)
    assert r.returncode==0,r.stderr+r.stdout
    result=json.loads((p/'返回结果.json').read_text(encoding='utf-8'))
    assert result['cleanBackground'] is True
    svg=ET.parse(output).getroot();ns={'s':'http://www.w3.org/2000/svg'}
    text=svg.find('.//s:text',ns)
    assert text.text==row['text']
    assert text.attrib['font-weight']=='800'
    assert text.attrib['font-size']=='64.000000'
    assert text.attrib['letter-spacing']=='1.600000'
    assert text.attrib['text-anchor']=='middle'
    assert text.attrib['transform']=='matrix(1.000000 0.000000 0.000000 1.000000 120.500000 87.250000)'
    image=svg.find('.//s:image',ns)
    data=base64.b64decode(image.attrib['{http://www.w3.org/1999/xlink}href'].split(',')[1])
    assert Image.open(io.BytesIO(data)).convert('RGB').getpixel((0,0))==(255,255,255)
    print('SVG clean plate, shared geometry, tracking, weight and Unicode spec passed')
