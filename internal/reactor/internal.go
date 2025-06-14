package reactor

import (
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/utils"
	"github.com/dustin/go-humanize"
	"github.com/robfig/cron/v3"
	"regexp"
	"sync"
	"time"
)

// 内部唤醒系统
// 每日生成当日活动计划，每小时要求 LLM 细化活动，增加真实感
// 活动计划分为 3 类：睡眠，户外活动，室内活动
// 睡眠状态下有概率因为忘记开启免打扰模式而被高频消息轰炸醒
// 户外活动状态下回消息频率低，周期检查变为 15~30 分钟，主动通知唤醒概率 -80%
// 室内活动状态下回消息频率高，周期检查变为 5 分钟，主动通知唤醒概率 ~15%，高频消息时会产生烦躁情绪，40% 概率开启 1 小时免打扰
const (
	Sleep   = 0
	Outdoor = 1
	Indoor  = 2
)

type Plan struct {
	Start       time.Time
	End         time.Time
	Description string
	Type        int32
}

type Internal struct {
	Energy  int32 // 能量值
	Plans   []Plan
	Current *Plan
}

var (
	once     sync.Once
	instance *Internal
)

func GetInternal() *Internal {
	once.Do(func() {
		instance = &Internal{}
	})
	return instance
}

func (i *Internal) Start() {
	GetDailyPlan()
	_, err := cron.New(cron.WithSeconds()).AddFunc("0 0 0 * * *", func() {
		// 每日生成当日活动计划
		GetDailyPlan()
	})
	if err != nil {
		log.Logger.Errorf("[Internal Schedule] cron error: %v", err)
	}
	_, err = cron.New(cron.WithSeconds()).AddFunc("0 * * * * *", func() {
		i.UpdateCurrentPlan()
	})
	if err != nil {
		log.Logger.Errorf("[Internal Schedule] cron error: %v", err)
	}
}

func (i *Internal) UpdateCurrentPlan() {
	now := time.Now()
	if i.Current != nil && i.Current.Start.Before(now) && i.Current.End.After(now) {
		// 当前计划未结束
		return
	}
	for _, plan := range GetInternal().Plans {
		if plan.Start.Before(now) && plan.End.After(now) {
			i.Current = &plan
			// 计划更改
			log.Logger.Infoln("[Internal Schedule] current plan changed: ", plan)
			utils.Bus.Publish(utils.PlanChanged, plan)
			return
		}
	}
	log.Logger.Infoln("[Internal Schedule] current plan not found: ", i.Current)
	i.Current = &Plan{
		Start:       now,
		End:         now,
		Description: "未安排计划",
		Type:        Indoor,
	}
}

func GetDailyPlan() {
	chat, err := llm.GetLLMManager().Chat(llm.CHAT, utils.DailyPlanPrompt, llm.Msg{
		Role: llm.USER,
		Content: `{
	"location": "武汉",
	"date": "2025-06-12",
	"weather": {
		"temperature": "29.6℃", 
		"conditions": "晴",
		"precipitation": "0mm",
		"aqi": 44,
		"sunrise": "05:19",
		"sunset": "19:25"
	}
}`,
	})
	if err != nil {
		log.Logger.Fatalf("[DailyPlan] think error: %v", err)
	}
	log.Logger.Infoln("[DailyPlan]", chat)
	regex := `([\d]{2}:[\d]{2})-([\d]{2}:[\d]{2})\s*?(🌳|🏠|💤)\s*?([^\n]+)\n`
	matches := regexp.MustCompile(regex).FindAllStringSubmatch(chat.Content, -1)
	now := time.Now()
	for _, match := range matches {
		start, _ := time.ParseInLocation("15:04", match[1], utils.GetLocation())
		start = start.AddDate(now.Year(), int(now.Month())-1, now.Day()-1)
		end, _ := time.ParseInLocation("15:04", match[2], utils.GetLocation())
		end = end.AddDate(now.Year(), int(now.Month())-1, now.Day()-1)
		if end.Before(start) {
			end = end.Add(1 * humanize.Day)
		}
		plan := Plan{
			Start:       start,
			End:         end,
			Description: match[4],
			Type:        getType(match[3]),
		}
		GetInternal().Plans = append(GetInternal().Plans, plan)
	}
	log.Logger.Infoln("[DailyPlan]", GetInternal().Plans)
	GetInternal().UpdateCurrentPlan()
}

func getType(s string) int32 {
	switch s {
	case "🌳":
		return Outdoor
	case "🏠":
		return Indoor
	case "💤":
		return Sleep
	default:
		return -1
	}
}

func (p *Plan) GetResponseRate() float32 {
	switch p.Type {
	case Outdoor:
		return 0.8
	case Indoor:
		return 0.9
	case Sleep:
		return 0.2
	default:
		return 0.5
	}
}
