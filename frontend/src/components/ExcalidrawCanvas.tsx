import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

type ExcalidrawFile = {
  id: string
  dataURL: string
  mimeType: string
  created: number
}

export type ExcalidrawCanvasData = {
  // Keep loose typing to avoid coupling to Excalidraw internals across versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: readonly any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appState: any
  files: Record<string, ExcalidrawFile>
}

export type ExcalidrawCanvasHandle = {
  addImage: (args: { url: string }) => Promise<void>
  sendImageToInput: (callback: (url: string) => void) => void
  add3DModelPreview: (args: { previewUrl: string; modelUrl: string; format: 'obj' | 'glb'; mtlUrl?: string; textureUrl?: string }) => Promise<void>
}

type ExcalidrawCanvasProps = Props & {
  on3DModelClick?: (modelUrl: string, format: 'obj' | 'glb', mtlUrl?: string, textureUrl?: string) => void
}

type Props = {
  canvasId: string
  theme?: 'dark' | 'light'
  initialData?: ExcalidrawCanvasData
  onDataChange: (data: ExcalidrawCanvasData) => void
  onImageToInput?: (url: string) => void
  onThemeChange?: (theme: 'dark' | 'light') => void
  on3DModelClick?: (modelUrl: string, format: 'obj' | 'glb') => void
  onModalClose?: () => void
}

function sanitizeAppState(appState: any) {
  if (!appState || typeof appState !== 'object') return {}

  // Excalidraw expects collaborators to be a Map. Once JSON-serialized, it often becomes `{}`,
  // which crashes inside Excalidraw (collaborators.forEach is not a function).
  // So we strip it on both load and save.
  const next = { ...appState }
  if ('collaborators' in next) {
    // Always remove to keep persisted data stable.
    // Excalidraw will re-initialize it internally.
    next.collaborators = undefined
  }
  return next
}

function sanitizeCanvasData(data: ExcalidrawCanvasData): ExcalidrawCanvasData {
  return {
    ...data,
    appState: sanitizeAppState(data.appState),
  }
}

function randomInt() {
  return Math.floor(Math.random() * 1_000_000)
}

function generateId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
}

function guessMimeType(url: string) {
  const u = (url || '').toLowerCase()
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.webp')) return 'image/webp'
  if (u.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

function isMediaElement(el: any) {
  return (
    el &&
    !el.isDeleted &&
    (el.type === 'image' || el.type === 'embeddable' || el.type === 'video')
  )
}

function computeNextPosition(elements: any[], maxNumPerRow = 4, spacing = 20) {
  // 给左上角控制栏预留空间，避免第一张图与按钮挤在一起
  const baseX = 40
  const baseY = 120

  const media = (elements || []).filter(isMediaElement)
  if (media.length === 0) return { x: baseX, y: baseY }

  // Sort by top-left corner
  media.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))

  // Group into rows by vertical overlap
  const rows: any[][] = []
  for (const el of media) {
    const y = el.y ?? 0
    const h = el.height ?? 0
    let placed = false
    for (const row of rows) {
      const overlaps = row.some((r) => {
        const ry = r.y ?? 0
        const rh = r.height ?? 0
        return Math.max(y, ry) < Math.min(y + h, ry + rh)
      })
      if (overlaps) {
        row.push(el)
        placed = true
        break
      }
    }
    if (!placed) rows.push([el])
  }

  rows.sort((ra, rb) => {
    const ay = ra.reduce((s, e) => s + (e.y ?? 0), 0) / ra.length
    const by = rb.reduce((s, e) => s + (e.y ?? 0), 0) / rb.length
    return ay - by
  })

  const lastRow = rows[rows.length - 1]
  lastRow.sort((a, b) => (a.x ?? 0) - (b.x ?? 0))

  if (lastRow.length < maxNumPerRow) {
    const right = lastRow[lastRow.length - 1]
    return {
      x: Math.max(baseX, (right.x ?? 0) + (right.width ?? 0) + spacing),
      y: Math.max(baseY, Math.min(...lastRow.map((e) => e.y ?? 0))),
    }
  }

  const bottom = Math.max(...lastRow.map((e) => (e.y ?? 0) + (e.height ?? 0)))
  return { x: baseX, y: Math.max(baseY, bottom + spacing) }
}

export const ExcalidrawCanvas = forwardRef<ExcalidrawCanvasHandle, Props>(
  ({ canvasId, theme, initialData, onDataChange, onImageToInput, onThemeChange, on3DModelClick, onModalClose }, ref) => {
    const [api, setApi] = useState<any>(null)
    const saveTimer = useRef<number | null>(null)
    const imageToInputCallbackRef = useRef<((url: string) => void) | null>(null)
    const lastThemeRef = useRef<'dark' | 'light' | null>(null)
    const lastSaveTimeRef = useRef<number>(0) // 记录上次保存时间
    const periodicSaveTimer = useRef<number | null>(null) // 30秒定时保存
    const lastClickTimeRef = useRef<number>(0) // 记录上次点击时间（用于双击检测）
    const lastClickedElementRef = useRef<string | null>(null) // 记录上次点击的元素ID
    const modalJustClosedRef = useRef<boolean>(false) // 标记弹框是否刚关闭（防止立即重新打开）
    const isInitialLoadRef = useRef<boolean>(true) // 标记是否是初始加载（防止页面加载时自动触发）

    const flushSave = useCallback(
      (data: ExcalidrawCanvasData) => {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        onDataChange(sanitizeCanvasData(data))
      },
      [onDataChange]
    )

    const snapshotScene = useCallback((): ExcalidrawCanvasData | null => {
      try {
        if (!api) return null
        const elements = api.getSceneElements ? api.getSceneElements() : null
        const appState = api.getAppState ? api.getAppState() : null
        const files = api.getFiles ? api.getFiles() : null
        if (!elements || !files) return null
        return sanitizeCanvasData({
          elements,
          appState: appState || {},
          files,
        })
      } catch {
        return null
      }
    }, [api])

    // 画布变化时立即保存（短防抖，避免频繁操作时请求过多）
    const debouncedSave = useCallback(
      (data: ExcalidrawCanvasData) => {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
        }
        // 画布变化时，短防抖500ms后保存
        saveTimer.current = window.setTimeout(() => {
          onDataChange(sanitizeCanvasData(data))
          // 记录保存时间，用于30秒定时保存判断
          lastSaveTimeRef.current = Date.now()
        }, 500)
      },
      [onDataChange]
    )

    useEffect(() => {
      // 30秒定时保存（仅在距离上次保存超过30秒时才保存）
      const startPeriodicSave = () => {
        if (periodicSaveTimer.current) {
          window.clearTimeout(periodicSaveTimer.current)
        }
        periodicSaveTimer.current = window.setTimeout(() => {
          const now = Date.now()
          // 如果距离上次保存超过30秒，才保存
          if (now - lastSaveTimeRef.current >= 30000) {
            const snap = snapshotScene()
            if (snap) {
              flushSave(snap)
              lastSaveTimeRef.current = now
            }
          }
          // 继续下一轮定时
          startPeriodicSave()
        }, 30000) // 每30秒检查一次
      }

      // 页面隐藏/切换标签时：如果距离上次保存超过30秒，才保存
      const onVisibilityChange = () => {
        if (document.hidden) {
          const now = Date.now()
          if (now - lastSaveTimeRef.current >= 30000) {
            const snap = snapshotScene()
            if (snap) {
              flushSave(snap)
              lastSaveTimeRef.current = now
            }
          }
        }
      }

      // 刷新/关闭/跳转时：如果距离上次保存超过30秒，才保存
      const onBeforeUnload = () => {
        // 清除防抖定时器
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        const now = Date.now()
        // 如果距离上次保存超过30秒，才保存
        if (now - lastSaveTimeRef.current >= 30000) {
          const snap = snapshotScene()
          if (snap) {
            flushSave(snap)
            lastSaveTimeRef.current = now
          }
        }
      }

      // 启动30秒定时保存
      startPeriodicSave()

      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('beforeunload', onBeforeUnload)

      return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('beforeunload', onBeforeUnload)
        if (periodicSaveTimer.current) {
          window.clearTimeout(periodicSaveTimer.current)
          periodicSaveTimer.current = null
        }
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
      }
    }, [flushSave, snapshotScene])

    // 标记初始加载完成（延迟1秒，确保Excalidraw完成初始渲染和数据恢复）
    useEffect(() => {
      const timer = setTimeout(() => {
        isInitialLoadRef.current = false
        console.log('✅ 初始加载完成，允许3D模型点击检测')
      }, 1000) // 1秒后允许点击检测
      
      return () => clearTimeout(timer)
    }, [])

    // 外部主题 -> Excalidraw（关键：让“切换主题”对画板生效）
    useEffect(() => {
      if (!api) return
      if (theme !== 'dark' && theme !== 'light') return
      if (lastThemeRef.current === theme) return
      lastThemeRef.current = theme
      try {
        // updateScene 会合并 appState；这里仅更新 theme，避免污染其它状态
        api.updateScene({ appState: { theme } })
      } catch (e) {
        // ignore
      }
    }, [api, theme])

    const initial = useMemo(() => {
      // Excalidraw expects initialData to be plain object; we keep it as-is.
      if (!initialData) return null
      return sanitizeCanvasData(initialData)
    }, [initialData])

    // 拼接多张图片为一张
    const combineImages = async (imageUrls: string[]): Promise<string> => {
      return new Promise((resolve, reject) => {
        const images: HTMLImageElement[] = []
        let loadedCount = 0

        const loadImage = (url: string, index: number) => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            images[index] = img
            loadedCount++
            if (loadedCount === imageUrls.length) {
              // 所有图片加载完成，开始拼接
              const maxWidth = Math.max(...images.map(img => img.width))
              const maxHeight = Math.max(...images.map(img => img.height))
              
              // 计算网格布局：尽量接近正方形
              const count = images.length
              const cols = Math.ceil(Math.sqrt(count))
              const rows = Math.ceil(count / cols)
              
              const canvas = document.createElement('canvas')
              canvas.width = maxWidth * cols
              canvas.height = maxHeight * rows
              const ctx = canvas.getContext('2d')
              
              if (!ctx) {
                reject(new Error('无法创建 canvas context'))
                return
              }
              
              // 填充白色背景
              ctx.fillStyle = '#ffffff'
              ctx.fillRect(0, 0, canvas.width, canvas.height)
              
              // 绘制每张图片
              images.forEach((img, index) => {
                const col = index % cols
                const row = Math.floor(index / cols)
                const x = col * maxWidth
                const y = row * maxHeight
                
                // 居中绘制
                const offsetX = (maxWidth - img.width) / 2
                const offsetY = (maxHeight - img.height) / 2
                
                ctx.drawImage(img, x + offsetX, y + offsetY)
              })
              
              // 转换为 data URL
              resolve(canvas.toDataURL('image/png'))
            }
          }
          img.onerror = () => {
            reject(new Error(`加载图片失败: ${url}`))
          }
          img.src = url
        }

        imageUrls.forEach((url, index) => {
          loadImage(url, index)
        })
      })
    }

    // 监听右键菜单，添加"发送到输入框"和"查看3D模型"选项
    useEffect(() => {
      if (!api) return

      let processTimer: number | null = null

      // 处理菜单的函数
      const processMenu = (contextMenu: Element) => {
        // 检查是否已经添加过菜单项（通过检查 DOM 中是否已存在）
        const existingItem = contextMenu.querySelector('[data-action="send-to-input"]')
        if (existingItem) {
          return // 已经添加过了，不再重复添加
        }
        
        // 给菜单容器打上我们自己的 class，方便精准美化
        try {
          ;(contextMenu as HTMLElement).classList.add('polystudio-excalidraw-menu')
        } catch {
          // ignore
        }
        
        // 检查选中的元素是否是3D模型预览图
        const currentElements = api.getSceneElements() || []
        const currentAppState = api.getAppState()
        const currentSelectedIds = currentAppState?.selectedElementIds || {}
        const selectedElement = currentElements.find((el: any) => 
          el && !el.isDeleted && el.type === 'image' && currentSelectedIds[el.id]
        )
        
        let is3DModel = false
        let modelUrl = ''
        let modelFormat: 'obj' | 'glb' = 'obj'
        
        // 尝试从多个字段解析3D模型信息
        if (selectedElement) {
          let linkData: any = null
          
          // 方式1: 从link字段解析（字符串格式）
          if (selectedElement.link && typeof selectedElement.link === 'string') {
            try {
              linkData = JSON.parse(selectedElement.link)
            } catch (e) {
              // 忽略
            }
          }
          
          // 方式2: 从customData字段解析（备用）
          if (!linkData && (selectedElement as any).customData) {
            try {
              const customData = (selectedElement as any).customData
              linkData = typeof customData === 'string' 
                ? JSON.parse(customData) 
                : customData
            } catch (e) {
              // 忽略
            }
          }
          
          // 方式3: 如果link是对象，直接使用
          if (!linkData && selectedElement.link && typeof selectedElement.link === 'object') {
            linkData = selectedElement.link
          }
          
          // 检查是否是3D模型
          if (linkData && linkData.type === '3d_model' && linkData.modelUrl && linkData.format) {
            is3DModel = true
            modelUrl = linkData.modelUrl
            modelFormat = linkData.format
          }
        }
        
        // 创建"查看3D模型"菜单项（仅当选中3D模型预览图时显示）
        if (is3DModel && on3DModelClick) {
          const view3DItem = document.createElement('div')
          view3DItem.className = 'context-menu-item polystudio-context-menu-item'
          view3DItem.setAttribute('data-action', 'view-3d-model')
          view3DItem.textContent = '查看3D模型'
          
          view3DItem.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            console.log('点击查看3D模型', { modelUrl, modelFormat, mtlUrl: linkData.mtlUrl, textureUrl: linkData.textureUrl })
            on3DModelClick(modelUrl, modelFormat, linkData.mtlUrl, linkData.textureUrl)
            
            // 关闭菜单
            const menu = contextMenu.closest('.context-menu') || contextMenu
            if (menu && menu.parentNode) {
              menu.parentNode.removeChild(menu)
            }
          })
          
          // 插入到菜单的最前面
          const firstChild = contextMenu.firstElementChild
          if (firstChild) {
            contextMenu.insertBefore(view3DItem, firstChild)
          } else {
            contextMenu.appendChild(view3DItem)
          }
        }
        
        // 创建"发送到输入框"菜单项（仅当onImageToInput存在时显示）
        if (onImageToInput) {
          const menuItem = document.createElement('div')
          menuItem.className = 'context-menu-item polystudio-context-menu-item'
          menuItem.setAttribute('data-action', 'send-to-input')
          menuItem.textContent = '发送到输入框'
        
        menuItem.addEventListener('click', async (e) => {
          e.preventDefault()
          e.stopPropagation()
          
          // 点击时检查是否有选中的图片
          const currentElements = api.getSceneElements() || []
          const currentAppState = api.getAppState()
          const currentSelectedIds = currentAppState?.selectedElementIds || {}
          
          const currentSelectedImages = currentElements.filter((el: any) => {
            if (!el || el.isDeleted || el.type !== 'image') return false
            return currentSelectedIds[el.id] || false
          })
          
          if (currentSelectedImages.length === 0) {
            // 没有选中图片，提示用户
            alert('请先选中图片')
            return
          }
          
          const files = api.getFiles?.() || {}
          const imageUrls = currentSelectedImages
            .map((el: any) => {
              const file = files[el.fileId]
              return file?.dataURL
            })
            .filter(Boolean) as string[]
          
          if (imageUrls.length === 0) {
            alert('无法获取图片数据')
            return
          }
          
          try {
            if (imageUrls.length === 1) {
              // 单张图片，直接发送
              onImageToInput(imageUrls[0])
            } else {
              // 多张图片，拼接后发送
              const combinedImage = await combineImages(imageUrls)
              onImageToInput(combinedImage)
            }
          } catch (error) {
            console.error('处理图片失败:', error)
            alert('处理图片失败，请重试')
          }
          
          // 关闭菜单
          const menu = contextMenu.closest('.context-menu') || contextMenu
          if (menu && menu.parentNode) {
            menu.parentNode.removeChild(menu)
          }
        })

          // 插入到菜单中（在3D模型菜单项之后）
          const view3DItem = contextMenu.querySelector('[data-action="view-3d-model"]')
          if (view3DItem && view3DItem.nextSibling) {
            contextMenu.insertBefore(menuItem, view3DItem.nextSibling)
          } else if (view3DItem) {
            contextMenu.appendChild(menuItem)
          } else {
            // 如果没有3D模型菜单项，插入到最前面
            const firstChild = contextMenu.firstElementChild
            if (firstChild) {
              contextMenu.insertBefore(menuItem, firstChild)
            } else {
              contextMenu.appendChild(menuItem)
            }
          }
        }
        
        // 隐藏所有分隔线（包括 Excalidraw 自己的）
        const allSeparators = contextMenu.querySelectorAll('hr, [role="separator"], .polystudio-context-separator')
        allSeparators.forEach((sep: Element) => {
          ;(sep as HTMLElement).style.display = 'none'
        })
        
        // 隐藏一些不常用的菜单项，精简菜单
        const menuItems = contextMenu.querySelectorAll('[role="menuitem"], .context-menu-item, button')
        menuItems.forEach((item: Element) => {
          const text = item.textContent || ''
          // 隐藏一些不常用的选项
          const hideItems = [
            'Wrap selection in frame',
            '复制为PNG 到剪贴板',
            '复制为 SVG 到剪贴板',
            '拷贝样式',
            '粘贴样式',
            '添加到素材库中',
            '全部锁定',
            'Copy link',
            'Copy link to object',
            '复制链接',
            '复制链接到对象',
          ]
          if (hideItems.some(hideText => text.includes(hideText))) {
            ;(item as HTMLElement).style.display = 'none'
          }
        })
      }

      // 使用 MutationObserver 监听右键菜单的出现
      const observer = new MutationObserver(() => {
        // 查找 Excalidraw 的右键菜单（可能有多种选择器）
        const contextMenu = document.querySelector('.context-menu') || 
                           document.querySelector('[class*="context-menu"]') ||
                           document.querySelector('[role="menu"]') ||
                           document.querySelector('.dropdown-menu')

        if (!contextMenu) {
          if (processTimer) {
            clearTimeout(processTimer)
            processTimer = null
          }
          return
        }
        
        // 清除之前的定时器
        if (processTimer) {
          clearTimeout(processTimer)
        }
        
        // 延迟处理，确保菜单完全渲染后再添加菜单项
        processTimer = window.setTimeout(() => {
          processMenu(contextMenu)
          processTimer = null
        }, 50)
      })

      // 观察整个文档的变化
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      })

      return () => {
        observer.disconnect()
        if (processTimer) {
          clearTimeout(processTimer)
        }
      }
    }, [api, onImageToInput, on3DModelClick, combineImages])

    useImperativeHandle(
      ref,
      () => ({
        sendImageToInput: (callback: (url: string) => void) => {
          imageToInputCallbackRef.current = callback
          // 获取当前选中的图片
          if (!api) return
          const elements = api.getSceneElements() || []
          const appState = api.getAppState()
          const selectedElementIds = appState?.selectedElementIds || {}
          
          const selectedImages = elements.filter((el: any) => {
            if (!el || el.isDeleted || el.type !== 'image') return false
            return selectedElementIds[el.id] || false
          })

          if (selectedImages.length > 0) {
            const imageEl = selectedImages[0]
            const files = api.getFiles?.() || {}
            const file = files[imageEl.fileId]
            if (file && file.dataURL) {
              callback(file.dataURL)
            }
          }
        },
        addImage: async ({ url }) => {
          if (!api) return

          const img = new Image()
          img.crossOrigin = 'anonymous'

          const { width, height } = await new Promise<{ width: number; height: number }>(
            (resolve) => {
              img.onload = () => resolve({ width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 })
              img.onerror = () => resolve({ width: 1024, height: 1024 })
              img.src = url
            }
          )

          const maxW = 300
          const scale = width > 0 ? Math.min(1, maxW / width) : 1
          const finalW = Math.max(32, Math.round(width * scale))
          const finalH = Math.max(32, Math.round(height * scale))

          const fileId = generateId('im')
          const created = Date.now()

          const file: ExcalidrawFile = {
            id: fileId,
            dataURL: url,
            mimeType: guessMimeType(url),
            created,
          }

          const elements = api.getSceneElements() || []
          const { x, y } = computeNextPosition(elements)

          // 在图片背后加一层白底板，避免深色画布背景导致“同图不同观感”（聊天里通常像白底卡片）
          const bgId = generateId('bg')
          const bgElement = {
            type: 'rectangle',
            id: bgId,
            x,
            y,
            width: finalW,
            height: finalH,
            angle: 0,
            strokeColor: 'transparent',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            strokeStyle: 'solid',
            strokeWidth: 1,
            roughness: 0,
            opacity: 100,
            groupIds: [],
            seed: randomInt(),
            version: 1,
            versionNonce: randomInt(),
            isDeleted: false,
            boundElements: null,
            roundness: null,
            frameId: null,
            updated: created,
            link: null,
            locked: false,
          }

          const newElement = {
            type: 'image',
            id: fileId,
            x,
            y,
            width: finalW,
            height: finalH,
            angle: 0,
            fileId,
            strokeColor: '#000000',
            fillStyle: 'solid',
            strokeStyle: 'solid',
            boundElements: null,
            roundness: null,
            frameId: null,
            backgroundColor: 'transparent',
            strokeWidth: 1,
            roughness: 0,
            opacity: 100,
            groupIds: [],
            seed: randomInt(),
            version: 1,
            versionNonce: randomInt(),
            isDeleted: false,
            index: null,
            updated: created,
            link: null,
            locked: false,
            status: 'saved',
            scale: [1, 1],
            crop: null,
          }

          api.addFiles([file])
          // 顺序很重要：先底板再图片，保证底板在下方
          const nextElements = [...elements, bgElement, newElement]
          api.updateScene({ elements: nextElements })

          // 关键：插入图片后立即强制保存一次（画布变化，立即保存）
          const nextFiles = { ...(api.getFiles?.() || {}), [fileId]: file }
          const nextAppState = api.getAppState ? api.getAppState() : {}
          flushSave({
            elements: nextElements,
            appState: nextAppState,
            files: nextFiles,
          })
          // 记录保存时间
          lastSaveTimeRef.current = Date.now()
        },
        add3DModelPreview: async ({ previewUrl, modelUrl, format, mtlUrl, textureUrl }) => {
          if (!api) return

          // 将预览图作为普通图片添加到画板
          const img = new Image()
          img.crossOrigin = 'anonymous'

          const { width, height } = await new Promise<{ width: number; height: number }>(
            (resolve) => {
              img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 400 })
              img.onerror = () => resolve({ width: 400, height: 400 })
              img.src = previewUrl
            }
          )

          const maxW = 300
          const scale = width > 0 ? Math.min(1, maxW / width) : 1
          const finalW = Math.max(32, Math.round(width * scale))
          const finalH = Math.max(32, Math.round(height * scale))

          const fileId = generateId('3d_preview')
          const created = Date.now()

          const file: ExcalidrawFile = {
            id: fileId,
            dataURL: previewUrl,
            mimeType: 'image/jpeg',
            created,
          }

          const elements = api.getSceneElements() || []
          const { x, y } = computeNextPosition(elements)

          // 在预览图背后加一层白底板
          const bgId = generateId('bg')
          const bgElement = {
            type: 'rectangle',
            id: bgId,
            x,
            y,
            width: finalW,
            height: finalH,
            angle: 0,
            strokeColor: 'transparent',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            strokeStyle: 'solid',
            strokeWidth: 1,
            roughness: 0,
            opacity: 100,
            groupIds: [],
            seed: randomInt(),
            version: 1,
            versionNonce: randomInt(),
            isDeleted: false,
            boundElements: null,
            roundness: null,
            frameId: null,
            updated: created,
            link: null,
            locked: false,
          }

          // 创建图片元素，并在link字段和customData中存储3D模型信息（双重保险）
          const modelInfo = JSON.stringify({ modelUrl, format, type: '3d_model', mtlUrl, textureUrl })
          const newElement: any = {
            type: 'image',
            id: fileId,
            x,
            y,
            width: finalW,
            height: finalH,
            angle: 0,
            fileId,
            strokeColor: '#0066ff',
            fillStyle: 'solid',
            strokeStyle: 'solid',
            boundElements: null,
            roundness: null,
            frameId: null,
            backgroundColor: 'transparent',
            strokeWidth: 2, // 蓝色边框标识这是3D模型预览
            roughness: 0,
            opacity: 100,
            groupIds: [],
            seed: randomInt(),
            version: 1,
            versionNonce: randomInt(),
            isDeleted: false,
            index: null,
            updated: created,
            link: modelInfo, // 存储3D模型信息（主要方式）
            customData: modelInfo, // 备用方式，防止link字段被Excalidraw处理
            locked: false,
            status: 'saved',
            scale: [1, 1],
            crop: null,
          }

          api.addFiles([file])
          const nextElements = [...elements, bgElement, newElement]
          api.updateScene({ elements: nextElements })

          // 保存
          const nextFiles = { ...(api.getFiles?.() || {}), [fileId]: file }
          const nextAppState = api.getAppState ? api.getAppState() : {}
          flushSave({
            elements: nextElements,
            appState: nextAppState,
            files: nextFiles,
          })
          lastSaveTimeRef.current = Date.now()

          // 注意：点击检测在onChange中处理，这里不需要额外的事件监听
        },
        clearSelection: () => {
          if (api && api.updateScene) {
            api.updateScene({ appState: { selectedElementIds: {} } })
            // 设置标记，防止关闭后立即重新打开
            modalJustClosedRef.current = true
            setTimeout(() => {
              modalJustClosedRef.current = false
            }, 500)
          }
        },
        api,
      }),
      [api, flushSave]
    )

    return (
      <div className="excalidraw-host" data-canvas-id={canvasId}>
        <Excalidraw
          langCode="zh-CN"
          excalidrawAPI={(instance) => setApi(instance)}
          initialData={initial as any}
          onChange={(elements: readonly any[], appState: any, files: any) => {
            const nextTheme = appState?.theme === 'light' ? 'light' : appState?.theme === 'dark' ? 'dark' : null
            if (nextTheme && nextTheme !== lastThemeRef.current) {
              lastThemeRef.current = nextTheme
              onThemeChange?.(nextTheme)
            }
            
            // 检测双击3D模型预览图（通过检测快速连续选中同一元素）
            // 如果弹框刚关闭或还在初始加载，忽略选中事件（防止自动触发）
            if (on3DModelClick && appState?.selectedElementIds && !modalJustClosedRef.current && !isInitialLoadRef.current) {
              const selectedIds = Object.keys(appState.selectedElementIds)
              if (selectedIds.length === 1) {
                const selectedId = selectedIds[0]
                const selectedElement = elements.find((el: any) => el.id === selectedId)
                
                if (selectedElement && selectedElement.type === 'image') {
                  // 尝试从多个字段解析3D模型信息（兼容不同保存方式）
                  let linkData: any = null
                  
                  // 方式1: 从link字段解析（字符串格式）
                  if (selectedElement.link && typeof selectedElement.link === 'string') {
                    try {
                      linkData = JSON.parse(selectedElement.link)
                      console.log('从link字段解析3D模型信息:', linkData)
                    } catch (e) {
                      console.warn('解析link字段失败:', selectedElement.link, e)
                    }
                  }
                  
                  // 方式2: 从customData字段解析（备用）
                  if (!linkData && (selectedElement as any).customData) {
                    try {
                      const customData = (selectedElement as any).customData
                      linkData = typeof customData === 'string' 
                        ? JSON.parse(customData) 
                        : customData
                      console.log('从customData字段解析3D模型信息:', linkData)
                    } catch (e) {
                      console.warn('解析customData字段失败:', e)
                    }
                  }
                  
                  // 方式3: 如果link是对象，直接使用
                  if (!linkData && selectedElement.link && typeof selectedElement.link === 'object') {
                    linkData = selectedElement.link
                    console.log('从link对象获取3D模型信息:', linkData)
                  }
                  
                  // 调试：打印元素信息
                  if (selectedElement.strokeColor === '#0066ff' && selectedElement.strokeWidth === 2) {
                    console.log('检测到3D模型预览图元素:', {
                      id: selectedId,
                      link: selectedElement.link,
                      customData: (selectedElement as any).customData,
                      parsedData: linkData
                    })
                  }
                  
                  if (linkData && linkData.type === '3d_model' && linkData.modelUrl && linkData.format) {
                    // 如果弹框刚关闭，忽略选中事件
                    if (modalJustClosedRef.current) {
                      console.log('弹框刚关闭，忽略选中事件')
                      lastClickedElementRef.current = null
                      return
                    }
                    
                    const now = Date.now()
                    // 检测双击：如果400ms内点击了同一个元素，认为是双击
                    if (lastClickedElementRef.current === selectedId && 
                        now - lastClickTimeRef.current < 400) {
                      // 双击触发
                      console.log('双击3D模型预览图，打开弹框', linkData)
                      on3DModelClick(linkData.modelUrl, linkData.format, linkData.mtlUrl, linkData.textureUrl)
                      lastClickedElementRef.current = null // 重置，避免重复触发
                      lastClickTimeRef.current = 0
                    } else {
                      // 记录单击
                      lastClickTimeRef.current = now
                      lastClickedElementRef.current = selectedId
                    }
                  } else {
                    lastClickedElementRef.current = null
                  }
                } else {
                  lastClickedElementRef.current = null
                }
              } else {
                lastClickedElementRef.current = null
              }
            }
            
            const data: ExcalidrawCanvasData = sanitizeCanvasData({
              elements,
              appState: appState,
              files,
            })
            debouncedSave(data)
          }}
        />
      </div>
    )
  }
)

ExcalidrawCanvas.displayName = 'ExcalidrawCanvas'

export default ExcalidrawCanvas


