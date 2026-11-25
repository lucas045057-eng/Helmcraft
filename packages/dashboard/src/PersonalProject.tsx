import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PersonalBinding, PersonalPlanRequest, PersonalProjectView, PersonalReports, TaskDetail } from '@agent-hub/protocol'
import { emptyResponse, errorText, json, request } from './api.js'

const phases:Record<string,string>={
  planning:'生成计划',plan_ready:'等待计划咨询',plan_consulting:'计划咨询中',implementation_ready:'等待实现',implementing:'实现中',
  verifying:'运行必需测试',review_ready:'等待审查',reviewing:'审查中',repair_ready:'等待修复',debug_ready:'等待诊断',
  diagnosing:'诊断中',reject_advice_ready:'等待审查咨询',reject_consulting:'审查咨询中',debug_advice_ready:'等待调试咨询',
  debug_consulting:'调试咨询中',delivery_ready:'等待提交',committing:'提交中',push_ready:'等待推送',pushing:'推送中',
  core_ready:'等待最终测试',verifying_final:'最终测试中',final_ready:'等待最终咨询',final_consulting:'最终咨询中',
  acceptance_ready:'等待确认工作区清理',done:'可验收',blocked:'已阻塞',stopped:'已停止',
}
const controls:Record<string,string>={paused:'已暂停派发',stop_requested:'等待在途任务收尾',releasing:'确认清理中',inspect:'等待人工核查'}
function download(name:string,contents:string) {
  const url=URL.createObjectURL(new Blob([contents],{type:'text/markdown;charset=utf-8'}))
  const link=document.createElement('a')
  link.href=url; link.download=name; link.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export function PersonalProject({open}:{open:(id:string)=>void}) {
  const cache=useQueryClient()
  const list=useQuery({queryKey:['personal-projects'],queryFn:()=>request('/personal/projects',PersonalProjectView.array()),refetchInterval:2000})
  const [selection,select]=useState(''), [creating,showForm]=useState(false)
  const project=list.data?.find(p=>p.id===selection) ?? list.data?.[0]
  const [snapshot,setSnapshot]=useState<{id:string;files:PersonalReports}>()

  const action=useMutation({mutationFn:async (input:{id:string;action:string})=>{
    const url='/personal/projects/'+encodeURIComponent(input.id)+'/'
    if(input.action==='reports') setSnapshot({id:input.id,files:await request(url+'reports',PersonalReports)})
    else await request(url+input.action,emptyResponse,json('POST'))
  },onSuccess:()=>cache.invalidateQueries({queryKey:['personal-projects']})})
  const start=useMutation({mutationFn:async (form:FormData)=>{
    const f=form.get('binding')
    if(!(f instanceof File) || f.size>65536) throw new Error('请选择有效的预检 JSON 文件')
    const data=JSON.parse(await f.text())
    if(data.ok!==true) throw new Error('预检未通过')
    const input=PersonalPlanRequest.parse({projectId:form.get('projectId'),sources:String(form.get('sources')).split(/[,，\n]/u).map(s=>s.trim()).filter(Boolean),binding:PersonalBinding.parse(data.binding)})
    await request('/personal/plans',TaskDetail,json('POST',input))
    select(input.projectId);showForm(false)
  },onSuccess:()=>cache.invalidateQueries({queryKey:['personal-projects']})})
  const closed=project && ['done','stopped'].includes(project.phase)
  const operate=(a:string)=>{if(project) action.mutate({id:project.id,action:a})}
  const error=(start.error && errorText(start.error)) || (action.error && errorText(action.error)) || (list.error && errorText(list.error))
  return <section className="surface personal-project" aria-label="个人项目">
    <div className="section-heading"><h2>个人项目</h2><button type="button" onClick={()=>showForm(!creating)}>{creating?'收起':'启动项目'}</button></div>
    {creating && <form onSubmit={e=>{e.preventDefault();start.mutate(new FormData(e.currentTarget))}}>
      <label>项目 ID<input name="projectId" required pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}" maxLength={64}/></label>
      <label>需求文件（逗号分隔）<input name="sources" required defaultValue="PRD.md"/></label>
      <label>Worker 预检文件<input name="binding" required type="file" accept=".json,application/json"/></label>
      <small>在 Worker 运行 personal-preflight，将输出的 JSON 保存为文件。</small>
      <button className="primary" disabled={start.isPending}>开始执行</button>
    </form>}
    {project && <><div className="personal-row">
      <select aria-label="选择个人项目" value={project.id} onChange={e=>select(e.target.value)}>{list.data?.map(p=><option key={p.id}>{p.id}</option>)}</select>
      <strong>{project.currentItem ?? '计划'} · {phases[project.phase] ?? project.phase}</strong><span>{controls[project.control]}</span>
      <button type="button" onClick={()=>open(project.taskId)}>任务与日志</button>
      {!closed && ['running','paused'].includes(project.control) && <>
        {project.phase!=='blocked' && <button disabled={action.isPending} onClick={()=>operate(project.control==='paused'?'resume':'pause')}>{project.control==='paused'?'继续派发':'暂停派发'}</button>}
        <button disabled={action.isPending} onClick={()=>operate('stop')}>停止项目</button></>}
      <button disabled={action.isPending} onClick={()=>operate('reports')}>生成报告快照</button></div>
      {project.reason && <p className="warning" role="status">阻塞原因 · {project.reason}</p>}
      {snapshot?.id===project.id && <div className="personal-row">{Object.entries(snapshot.files).map(([name,contents])=><button key={name} onClick={()=>download(name,contents)}>{name}</button>)}</div>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>
}
